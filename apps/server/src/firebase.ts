import { FieldValue } from "firebase-admin/firestore";
import { diagnostic } from "./diagnostics.js";
import { assertDeviceContext, type DeviceIdentity } from "./device-access.js";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
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

  constructor(dependencies: FirebaseBackendDependencies) {
    this.firestore = dependencies.firestore;
    this.bucket = dependencies.bucket;
    this.auth = dependencies.auth;
    this.cleanupIntervalMs = dependencies.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.dispose = dependencies.dispose;
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

  async deleteItem(uid: string, contextId: string, itemId: string, device?: DeviceIdentity): Promise<void> {
    const reference = this.firestore.doc(itemPath(uid, contextId, itemId));
    const deletionMarker = this.firestore.doc(`users/${uid}/deletedItems/${contextId}_${itemId}`);
    const exists = await this.firestore.runTransaction(async (transaction) => {
      const [snapshot, parent, previousMarker] = await Promise.all([transaction.get(reference), transaction.get(this.firestore.doc(contextPath(uid, contextId))), transaction.get(deletionMarker)]);
      const access = parent.data() ?? previousMarker.data();
      if (device) await assertDeviceContext(this.firestore, device, access, transaction);
      const originDeviceId = access?.originDeviceId;
      transaction.set(deletionMarker, { deleted: true, ...(typeof originDeviceId === "string" ? { originDeviceId } : {}) });
      if (!snapshot.exists) return false;
      const record = snapshot.data() as ItemRecord;
      if (record.deleting !== true) transaction.update(reference, { deleting: true });
      return true;
    });
    if (!exists) { await this.repairContextAfterItemDeletion(uid, contextId, itemId, device); return; }

    await this.deleteObjectGenerations(`${itemPath(uid, contextId, itemId)}/`);
    await reference.delete();
    await this.repairContextAfterItemDeletion(uid, contextId, itemId, device);
  }

  private async repairContextAfterItemDeletion(uid: string, contextId: string, removedId: string, device?: DeviceIdentity) {
    const parent = this.firestore.doc(contextPath(uid, contextId));
    const empty = await this.firestore.runTransaction(async tx => {
      const context = await tx.get(parent);
      if (!context.exists || context.data()?.deleting !== false) return false;
      const remaining = await tx.get(parent.collection("items").where("deleting", "==", false).orderBy("createdAt").limit(1));
      const first = remaining.docs[0];
      if (!first) return true;
      if (context.data()?.firstItemId === removedId) {
        tx.update(parent, { firstItemId: first.id, ready: first.data().ready === true,
          ...(context.data()?.titleState === "pending" ? { titleState: "fallback", titleLease: FieldValue.delete(), titleLeaseUntil: FieldValue.delete() } : {}) });
      }
      return false;
    });
    if (empty) await this.deleteContext(uid, contextId, device);
  }

  async deleteContext(uid: string, contextId: string, device?: DeviceIdentity): Promise<void> {
    const reference = this.firestore.doc(contextPath(uid, contextId));
    const deletionMarker = this.firestore.doc(`users/${uid}/deletedContexts/${contextId}`);
    const exists = await this.firestore.runTransaction(async (transaction) => {
      const [snapshot, previousMarker] = await Promise.all([transaction.get(reference), transaction.get(deletionMarker)]);
      const access = snapshot.data() ?? previousMarker.data();
      if (device) await assertDeviceContext(this.firestore, device, access, transaction);
      // Retain only the deleted UUID, so a disconnected client's original
      // create cannot resurrect content after the cleanup removes this parent.
      const originDeviceId = access?.originDeviceId;
      transaction.set(deletionMarker, { deleted: true, ...(typeof originDeviceId === "string" ? { originDeviceId } : {}) });
      if (!snapshot.exists) return false;
      const record = snapshot.data() as ContextRecord;
      if (record.deleting !== true) transaction.update(reference, { deleting: true });
      return true;
    });
    if (!exists) return;

    while (true) {
      const items = await reference.collection("items").limit(CLEANUP_BATCH_SIZE).get();
      if (items.empty) break;
      for (const item of items.docs) {
        await this.deleteItem(uid, contextId, item.id);
      }
    }
    await this.deleteObjectGenerations(`${contextPath(uid, contextId)}/`);
    await reference.delete();
  }

  private async deleteObjectGenerations(prefix: string): Promise<void> {
    while (true) {
      const [files] = await this.bucket.getFiles({
        prefix,
        maxResults: OBJECT_BATCH_SIZE,
        autoPaginate: false,
        versions: true,
      });
      if (files.length === 0) return;
      await Promise.all(
        files.map((file) => {
          const generation = file.metadata.generation;
          if (generation === undefined) throw new Error("Object generation unavailable");
          return file.delete({
            ignoreNotFound: true,
            ifGenerationMatch: generation,
          });
        }),
      );
    }
  }

  async runCleanupPass(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const contexts = await this.firestore
        .collectionGroup("contexts")
        .where("deleting", "==", true)
        .limit(CLEANUP_BATCH_SIZE)
        .get();
      for (const document of contexts.docs) {
        const parsed = parseContextDocumentPath(document.ref.path);
        if (parsed) await this.deleteContext(parsed.uid, parsed.contextId);
      }

      const items = await this.firestore
        .collectionGroup("items")
        .where("deleting", "==", true)
        .limit(CLEANUP_BATCH_SIZE)
        .get();
      for (const document of items.docs) {
        const parsed = parseItemDocumentPath(document.ref.path);
        if (parsed) await this.deleteItem(parsed.uid, parsed.contextId, parsed.itemId);
      }
    } finally {
      this.cleanupRunning = false;
    }
  }

  async startCleanup(): Promise<void> {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.attemptCleanup();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
    await this.attemptCleanup();
  }

  private async attemptCleanup(): Promise<void> {
    try {
      await this.runCleanupPass();
      this.cleanupFailure = undefined;
    } catch (error) {
      // Tombstones remain persisted; readiness reports the failure while the next bounded pass retries.
      this.cleanupFailure = new Error("Cleanup failed");
      diagnostic("cleanup", "pass-failed");
    }
  }

  async checkReady(): Promise<void> {
    await Promise.all([
      this.firestore.doc("internalHealth/readiness").get(),
      this.bucket.getMetadata(),
    ]);
    if (this.cleanupFailure) throw new Error("Cleanup unavailable");
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    await this.dispose?.();
  }
}
