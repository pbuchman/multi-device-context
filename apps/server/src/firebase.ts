import { FieldValue } from "firebase-admin/firestore";
import { diagnostic } from "./diagnostics.js";
import { IoWatchdog, type IoOperation } from "./io-watchdog.js";
import { assertDeviceContext, assertDeviceDeletion, type DeviceIdentity } from "./device-access.js";
import type { Auth } from "firebase-admin/auth";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";

import type { Backend } from "./server.js";
import { BackendConflictError, BackendNotFoundError } from "./backend-errors.js";

type Bucket = ReturnType<Storage["bucket"]>;

type FirebaseBackendDependencies = {
  firestore: Firestore;
  bucket: Bucket;
  auth: Auth;
  cleanupIntervalMs?: number;
  dispose?: () => Promise<void>;
  onFatal?: (operation: IoOperation) => void;
};

type ContextRecord = { deleting?: unknown };
type ItemRecord = {
  content?: {
    kind?: unknown;
    size?: unknown;
    contentType?: unknown;
  };
  ready?: unknown;
  deleting?: unknown;
};

const CLEANUP_BATCH_SIZE = 25;
const OBJECT_BATCH_SIZE = 100;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

function contextPath(uid: string, contextId: string): string {
  return `users/${uid}/contexts/${contextId}`;
}

function itemPath(uid: string, contextId: string, itemId: string): string {
  return `${contextPath(uid, contextId)}/items/${itemId}`;
}

function objectPath(uid: string, contextId: string, itemId: string): string {
  return `${itemPath(uid, contextId, itemId)}/original`;
}

function isMissingObject(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 404
  );
}

function parseContextDocumentPath(path: string): { uid: string; contextId: string } | undefined {
  const match = /^users\/([^/]+)\/contexts\/([^/]+)$/.exec(path);
  return match?.[1] && match[2] ? { uid: match[1], contextId: match[2] } : undefined;
}

function parseItemDocumentPath(
  path: string,
): { uid: string; contextId: string; itemId: string } | undefined {
  const match = /^users\/([^/]+)\/contexts\/([^/]+)\/items\/([^/]+)$/.exec(path);
  return match?.[1] && match[2] && match[3]
    ? { uid: match[1], contextId: match[2], itemId: match[3] }
    : undefined;
}

export class FirebaseBackend implements Backend {
  private readonly firestore: Firestore;
  private readonly bucket: Bucket;
  private readonly auth: Auth;
  private readonly cleanupIntervalMs: number;
  private readonly dispose: (() => Promise<void>) | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private cleanupRunning = false;
  private cleanupFailure: Error | undefined;
  private readonly io: IoWatchdog;
  private closing?: Promise<void>;

  constructor(dependencies: FirebaseBackendDependencies) {
    this.firestore = dependencies.firestore;
    this.bucket = dependencies.bucket;
    this.auth = dependencies.auth;
    this.cleanupIntervalMs = dependencies.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.dispose = dependencies.dispose;
    this.io = new IoWatchdog(operation => {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      dependencies.onFatal?.(operation);
    });
  }

  async createCustomToken(uid: string, deviceId: string): Promise<string> {
    return this.auth.createCustomToken(uid, { mdcDeviceId: deviceId });
  }

  async completeUpload(uid: string, contextId: string, itemId: string, device?: DeviceIdentity): Promise<void> {
    const contextRef = this.firestore.doc(contextPath(uid, contextId));
    const itemRef = this.firestore.doc(itemPath(uid, contextId, itemId));
    const [contextSnapshot, itemSnapshot] = await Promise.all([contextRef.get(), itemRef.get()]);
    if (!contextSnapshot.exists || !itemSnapshot.exists) throw new BackendNotFoundError();

    const context = contextSnapshot.data() as ContextRecord;
    if (device) await assertDeviceContext(this.firestore, device, contextSnapshot.data());
    const item = itemSnapshot.data() as ItemRecord;
    this.assertCompletable(context, item);
    if (item.ready === true) return;

    const file = this.bucket.file(objectPath(uid, contextId, itemId));
    let metadata: { size?: string | number; contentType?: string };
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (isMissingObject(error)) throw new BackendNotFoundError();
      throw error;
    }
    if (
      Number(metadata.size) !== item.content?.size ||
      metadata.contentType !== item.content?.contentType
    ) {
      throw new BackendConflictError();
    }

    // Firebase adds bearer download tokens during uploads, before evaluating
    // rules. Remove them before making the attachment visible to any client.
    try {
      const [privateMetadata] = await file.setMetadata({
        metadata: { firebaseStorageDownloadTokens: null },
      });
      if (privateMetadata.metadata?.firebaseStorageDownloadTokens) {
        throw new Error("Attachment privacy metadata could not be finalized");
      }
    } catch (error) {
      if (isMissingObject(error)) throw new BackendNotFoundError();
      throw error;
    }

    await this.firestore.runTransaction(async (transaction) => {
      const [currentContextSnapshot, currentItemSnapshot] = await Promise.all([
        transaction.get(contextRef),
        transaction.get(itemRef),
      ]);
      if (!currentContextSnapshot.exists || !currentItemSnapshot.exists) {
        throw new BackendNotFoundError();
      }
      const currentContext = currentContextSnapshot.data() as ContextRecord;
      if (device) await assertDeviceContext(this.firestore, device, currentContextSnapshot.data(), transaction);
      const currentItem = currentItemSnapshot.data() as ItemRecord;
      this.assertCompletable(currentContext, currentItem);
      if (currentItem.ready === true) return;
      if (
        currentItem.content?.size !== item.content?.size ||
        currentItem.content?.contentType !== item.content?.contentType
      ) {
        throw new BackendConflictError();
      }
      transaction.update(itemRef, { ready: true });
      if (currentContextSnapshot.data()?.firstItemId === itemId) transaction.update(contextRef, { ready: true });
    });
  }

  private assertCompletable(context: ContextRecord, item: ItemRecord): void {
    if (
      context.deleting !== false ||
      item.deleting !== false ||
      item.content?.kind !== "attachment" ||
      typeof item.content.size !== "number" ||
      typeof item.content.contentType !== "string"
    ) {
      throw new BackendConflictError();
    }
  }

  isFatal() { return this.io.fatal; }
  isUnavailable() { return this.io.fatal || this.cleanupFailure !== undefined; }

  private deletionTransaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.io.run("deletion-firestore", () => this.firestore.runTransaction(async transaction => {
      this.io.assertActive();
      const guarded = new Proxy(transaction, {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            this.io.assertActive();
            if (property === "get" || property === "getAll")
              return this.io.run("deletion-firestore", () => Reflect.apply(value, target, args));
            return Reflect.apply(value, target, args);
          };
        },
      });
      const result = await callback(guarded);
      this.io.assertActive();
      return result;
    }));
  }

  async deleteItem(uid: string, contextId: string, itemId: string, device?: DeviceIdentity, deleteEmptyContext = false): Promise<void> {
    if (deleteEmptyContext) return this.deleteItemAndEmptyContext(uid, contextId, itemId, device);
    const reference = this.firestore.doc(itemPath(uid, contextId, itemId));
    const deletionMarker = this.firestore.doc(`users/${uid}/deletedItems/${contextId}_${itemId}`);
    const exists = await this.deletionTransaction(async (transaction) => {
      const [snapshot, parent, previousMarker, parentMarker] = await Promise.all([
        transaction.get(reference), transaction.get(this.firestore.doc(contextPath(uid, contextId))),
        transaction.get(deletionMarker), transaction.get(this.firestore.doc(`users/${uid}/deletedContexts/${contextId}`)),
      ]);
      const evidence = [parent.data(), parentMarker.data(), previousMarker.data()];
      const originDeviceId = device
        ? await assertDeviceDeletion(this.firestore, uid, device, evidence, !snapshot.exists, transaction)
        : evidence.find(record => record !== undefined)?.originDeviceId;
      if (!previousMarker.exists) transaction.set(deletionMarker, { deleted: true, ...(typeof originDeviceId === "string" ? { originDeviceId } : {}) });
      if (!snapshot.exists) return false;
      const record = snapshot.data() as ItemRecord;
      if (record.deleting !== true) transaction.update(reference, { deleting: true });
      return true;
    });
    if (!exists) { await this.repairFirstItem(uid, contextId, itemId); return; }

    await this.deleteObjectGenerations(`${itemPath(uid, contextId, itemId)}/`);
    await this.io.run("deletion-firestore", () => reference.delete());
    await this.repairFirstItem(uid, contextId, itemId);
  }

  private async repairFirstItem(uid: string, contextId: string, removedId: string) {
    const parent = this.firestore.doc(contextPath(uid, contextId));
    await this.deletionTransaction(async tx => {
      const context = await tx.get(parent);
      if (!context.exists || context.data()?.deleting !== false || context.data()?.firstItemId !== removedId) return;
      const remaining = await tx.get(parent.collection("items").where("deleting", "==", false).orderBy("createdAt").limit(1));
      const first = remaining.docs[0];
      tx.update(parent, { firstItemId: first?.id ?? FieldValue.delete(), ready: first ? first.data().ready === true : true,
        ...(context.data()?.titleState === "pending" ? { titleState: "fallback", titleLease: FieldValue.delete(), titleLeaseUntil: FieldValue.delete() } : {}) });
    });
  }

  private async deleteItemAndEmptyContext(uid: string, contextId: string, itemId: string, device?: DeviceIdentity): Promise<void> {
    const parent = this.firestore.doc(contextPath(uid, contextId));
    const item = this.firestore.doc(itemPath(uid, contextId, itemId));
    const itemMarker = this.firestore.doc(`users/${uid}/deletedItems/${contextId}_${itemId}`);
    const contextMarker = this.firestore.doc(`users/${uid}/deletedContexts/${contextId}`);
    const result = await this.deletionTransaction(async transaction => {
      const [context, target, previousItemMarker, previousContextMarker, live] = await Promise.all([
        transaction.get(parent), transaction.get(item), transaction.get(itemMarker),
        transaction.get(contextMarker),
        transaction.get(parent.collection("items").where("deleting", "==", false).limit(2)),
      ]);
      // A missing parent does not prove its subcollection is empty. In
      // particular, an absent target must not authorize sweeping orphan items.
      const descendants = !context.exists ? await transaction.get(parent.collection("items").limit(1)) : undefined;
      const whollyAbsent = !target.exists && (!descendants || descendants.empty);
      const evidence = [context.data(), previousContextMarker.data(), previousItemMarker.data()];
      const originDeviceId = device
        ? await assertDeviceDeletion(this.firestore, uid, device, evidence, whollyAbsent, transaction)
        : evidence.find(record => record !== undefined)?.originDeviceId;
      const marker = { deleted: true, ...(typeof originDeviceId === "string" ? { originDeviceId } : {}) };
      if (!previousItemMarker.exists) transaction.set(itemMarker, marker);
      if (context.exists && context.data()?.deleting === true && previousContextMarker.exists) return "context" as const;
      const hasSibling = live.docs.some(entry => entry.id !== itemId);
      if (!hasSibling && ((!context.exists && whollyAbsent) || context.data()?.deleting === false)) {
        if (!previousContextMarker.exists) transaction.set(contextMarker, marker);
        if (context.exists) transaction.update(parent, { deleting: true });
        if (target.exists && target.data()?.deleting !== true) transaction.update(item, { deleting: true });
        return context.exists ? "context" as const : "missing" as const;
      }
      if (target.exists && target.data()?.deleting !== true) transaction.update(item, { deleting: true });
      return target.exists ? "item" as const : "missing" as const;
    });
    if (result === "context") { await this.cleanupMarkedContext(uid, contextId); return; }
    if (result === "missing") { await this.repairFirstItem(uid, contextId, itemId); return; }
    await this.deleteObjectGenerations(`${itemPath(uid, contextId, itemId)}/`);
    await this.io.run("deletion-firestore", () => item.delete());
    await this.repairFirstItem(uid, contextId, itemId);
  }

  async deleteContext(uid: string, contextId: string, device?: DeviceIdentity): Promise<void> {
    const reference = this.firestore.doc(contextPath(uid, contextId));
    const deletionMarker = this.firestore.doc(`users/${uid}/deletedContexts/${contextId}`);
    const exists = await this.deletionTransaction(async (transaction) => {
      const [snapshot, previousMarker] = await Promise.all([transaction.get(reference), transaction.get(deletionMarker)]);
      const evidence = [snapshot.data(), previousMarker.data()];
      const originDeviceId = device
        ? await assertDeviceDeletion(this.firestore, uid, device, evidence, !snapshot.exists, transaction)
        : evidence.find(record => record !== undefined)?.originDeviceId;
      // The absent-parent read and tombstone commit conflict with concurrent creates.
      // Retain existing provenance so retries cannot reassign a deleted context.
      if (!previousMarker.exists) transaction.set(deletionMarker, { deleted: true, ...(typeof originDeviceId === "string" ? { originDeviceId } : {}) });
      if (!snapshot.exists) return false;
      const record = snapshot.data() as ContextRecord;
      if (record.deleting !== true) transaction.update(reference, { deleting: true });
      return true;
    });
    if (!exists) return;
    await this.cleanupMarkedContext(uid, contextId);
  }

  private async cleanupMarkedContext(uid: string, contextId: string): Promise<void> {
    const reference = this.firestore.doc(contextPath(uid, contextId));
    while (true) {
      const items = await this.io.run("deletion-firestore", () => reference.collection("items").limit(CLEANUP_BATCH_SIZE).get());
      if (items.empty) break;
      for (const item of items.docs) {
        await this.deleteItem(uid, contextId, item.id);
      }
    }
    await this.deleteObjectGenerations(`${contextPath(uid, contextId)}/`);
    await this.io.run("deletion-firestore", () => reference.delete());
  }

  private async deleteObjectGenerations(prefix: string): Promise<void> {
    while (true) {
      const [files] = await this.io.run("deletion-storage", () => this.bucket.getFiles({
        prefix,
        maxResults: OBJECT_BATCH_SIZE,
        autoPaginate: false,
        versions: true,
      }));
      if (files.length === 0) return;
      await Promise.all(
        files.map((file) => {
          const generation = file.metadata.generation;
          if (generation === undefined) throw new Error("Object generation unavailable");
          return this.io.run("deletion-storage", () => file.delete({
            ignoreNotFound: true,
            ifGenerationMatch: generation,
          }));
        }),
      );
    }
  }

  async runCleanupPass(): Promise<void> {
    this.io.assertActive();
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const contexts = await this.io.run("cleanup-firestore", () => this.firestore
        .collectionGroup("contexts")
        .where("deleting", "==", true)
        .limit(CLEANUP_BATCH_SIZE)
        .get());
      for (const document of contexts.docs) {
        const parsed = parseContextDocumentPath(document.ref.path);
        if (parsed) await this.deleteContext(parsed.uid, parsed.contextId);
      }

      const items = await this.io.run("cleanup-firestore", () => this.firestore
        .collectionGroup("items")
        .where("deleting", "==", true)
        .limit(CLEANUP_BATCH_SIZE)
        .get());
      for (const document of items.docs) {
        const parsed = parseItemDocumentPath(document.ref.path);
        if (parsed) await this.deleteItem(parsed.uid, parsed.contextId, parsed.itemId);
      }
    } finally {
      // A timed-out SDK call may still be pending. Never unlock it for another pass.
      if (!this.io.fatal) this.cleanupRunning = false;
    }
  }

  async startCleanup(): Promise<void> {
    this.io.assertActive();
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.attemptCleanup();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
    await this.attemptCleanup();
  }

  private async attemptCleanup(): Promise<void> {
    // A skipped overlapping schedule is not evidence that a failing pass recovered.
    if (this.cleanupRunning) return;
    try {
      await this.runCleanupPass();
      this.io.assertActive();
      this.cleanupFailure = undefined;
    } catch (error) {
      // Tombstones remain persisted; readiness reports the failure while the next bounded pass retries.
      this.cleanupFailure = new Error("Cleanup failed");
      diagnostic("cleanup", "pass-failed");
    }
  }

  async checkReady(): Promise<void> {
    this.io.assertActive();
    // Wait for both guarded probes: an early settled failure must not leave its
    // peer running while the scheduler starts another readiness check.
    const results = await Promise.allSettled([
      this.io.run("readiness-firestore", () => this.firestore.doc("internalHealth/readiness").get(), 10_000),
      this.io.run("readiness-storage", () => this.bucket.getMetadata(), 10_000),
    ]);
    this.io.assertActive();
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (this.cleanupFailure) throw new Error("Cleanup unavailable");
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.io.close();
    this.closing ??= Promise.resolve().then(() => this.dispose?.());
    await this.closing;
  }
}
