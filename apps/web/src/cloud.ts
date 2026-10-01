import { apiUrl } from "./api.js";
import { liveDocumentQuery } from "./queries.js";
import { ContentSchema, DeviceSchema, attachmentPath, type Content, type Device, type Id, type AgentKeyInfo } from "@mdc/contracts";
import type { FirebaseApp } from "firebase/app";
import {
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDocs,
  getDocsFromServer,
  initializeFirestore,
  onSnapshot,
  memoryLocalCache,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getBlob, getStorage, ref, uploadBytes, type FirebaseStorage } from "firebase/storage";

import type { ContextRecord, ItemRecord } from "./model.js";
import { PublishFailure, type QueuedShare } from "./outbox.js";

type ExistingItem = { content: Content; device: Device; ready: boolean };
export type CloudWritePort = {
  findContext(contextId: Id): Promise<{ id: Id } | undefined>;
  findItem(contextId: Id, itemId: Id): Promise<ExistingItem | undefined>;
  createInitial(record: QueuedShare): Promise<void>;
  append(record: QueuedShare): Promise<void>;
  completeAttachment(record: QueuedShare): Promise<"complete" | "missing">;
  upload(record: QueuedShare, bytes: Uint8Array): Promise<void>;
};

export type CloudSnapshot<T> = {
  records: T[];
  fromCache: boolean;
  hasPendingWrites: boolean;
};

function immutableEqual(record: QueuedShare, existing: ExistingItem): boolean {
  return JSON.stringify(existing.content) === JSON.stringify(record.content)
    && JSON.stringify(existing.device) === JSON.stringify(record.device);
}

export function cloudFailure(error: unknown): PublishFailure {
  if (error instanceof PublishFailure) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  const rejected = ["unauthenticated", "permission-denied", "unauthorized", "quota-exceeded", "resource-exhausted"]
    .some((label) => code === label || code.endsWith(`/${label}`));
  if (rejected) {
    const authentication = code.includes("unauthenticated") || code.includes("unauthorized");
    return new PublishFailure(authentication ? "Sign in again to continue sharing" : "This share needs your attention before retrying", false);
  }
  const message = error instanceof Error && error.message ? error.message : "Cloud service is temporarily unavailable";
  return new PublishFailure(message, true);
}

export async function publishQueuedShare(record: QueuedShare, port: CloudWritePort): Promise<void> {
  const context = await port.findContext(record.contextId);
  let item: ExistingItem | undefined;
  if (!context) {
    if (!record.createsContext) throw new PublishFailure("This context was deleted on another device", false);
    await port.createInitial(record);
  } else {
    item = await port.findItem(record.contextId, record.itemId);
    if (item && !immutableEqual(record, item)) {
      throw new PublishFailure("A different item already uses this identifier", false);
    }
    if (!item) await port.append(record);
  }
  if (record.content.kind !== "attachment") return;
  if (!record.bytes || record.bytes.byteLength !== record.content.size) {
    throw new PublishFailure("Attachment bytes are missing or changed", false);
  }
  if (item?.ready) return;
  if (await port.completeAttachment(record) === "complete") return;
  try {
    await port.upload(record, record.bytes);
  } catch (uploadError) {
    if (await port.completeAttachment(record) === "complete") return;
    throw uploadError;
  }
  if (await port.completeAttachment(record) !== "complete") {
    throw new PublishFailure("The uploaded file could not be finalized", true);
  }
}

export async function isDeletedContextError(error: { code?: string }, contextStillExists: () => Promise<boolean>): Promise<boolean> {
  if (error.code !== "permission-denied") return false;
  // Deleting a parent revokes item-listener access before the parent snapshot
  // necessarily arrives. Suppress only a deletion confirmed by an authorized
  // server read; genuine permission/auth/network failures still reach the UI.
  try { return !await contextStillExists(); } catch { return false; }
}

function timestampMillis(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    return value.toMillis();
  }
  return Date.now();
}

function contextFromDocument(document: QueryDocumentSnapshot<DocumentData>): ContextRecord | undefined {
  const data = document.data();
  if (typeof data.title !== "string") return undefined;
  return {
    id: document.id as Id,
    title: data.title,
    ...(typeof data.originDeviceId === "string" ? { originDeviceId: data.originDeviceId } : {}),
    ...(typeof data.ready === "boolean" ? { ready: data.ready } : {}),
    createdAt: timestampMillis(data.createdAt),
    updatedAt: timestampMillis(data.updatedAt),
    syncState: document.metadata.hasPendingWrites ? "pending" : document.metadata.fromCache ? "cached" : "synced",
  };
}

function itemFromDocument(contextId: Id, document: QueryDocumentSnapshot<DocumentData>): ItemRecord | undefined {
  const data = document.data();
  const content = ContentSchema.safeParse(data.content);
  const device = DeviceSchema.safeParse(data.device);
  if (!content.success || !device.success || typeof data.ready !== "boolean") return undefined;
  return {
    id: document.id as Id,
    contextId,
    content: content.data,
    device: device.data,
    createdAt: timestampMillis(data.createdAt),
    ready: data.ready,
    syncState: document.metadata.hasPendingWrites ? "pending" : document.metadata.fromCache ? "cached" : "synced",
  };
}

function sorted<T extends { id: Id; createdAt: number }>(records: T[], descending: boolean): T[] {
  return records.sort((left, right) =>
    (descending ? right.createdAt - left.createdAt : left.createdAt - right.createdAt)
      || left.id.localeCompare(right.id));
}

export class FirebaseCloud {
  readonly #firestore: Firestore;
  readonly #storage: FirebaseStorage;
  #networkEnabled = true;
  #networkTransition: Promise<void> = Promise.resolve();

  constructor(
    app: FirebaseApp,
    readonly uid: string,
    private readonly accessToken: () => Promise<string>,
  ) {
    this.#firestore = initializeFirestore(app, {
      localCache: memoryLocalCache(),
    });
    this.#storage = getStorage(app);
  }

  subscribeContexts(
    emit: (snapshot: CloudSnapshot<ContextRecord>) => void,
    fail: (error: Error) => void,
  ): Unsubscribe {
    const live = query(collection(this.#firestore, `users/${this.uid}/contexts`), where("deleting", "==", false));
    return onSnapshot(live, { includeMetadataChanges: true }, (snapshot) => {
      const records = snapshot.docs.map(contextFromDocument).filter((value): value is ContextRecord => Boolean(value));
      records.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
      emit({ records, fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
    }, (error) => fail(error));
  }

  async refreshContexts(): Promise<CloudSnapshot<ContextRecord>> {
    const live = query(collection(this.#firestore, `users/${this.uid}/contexts`), where("deleting", "==", false));
    const snapshot = await getDocsFromServer(live);
    const records = snapshot.docs.map(contextFromDocument).filter((value): value is ContextRecord => Boolean(value));
    records.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    return { records, fromCache: false, hasPendingWrites: snapshot.metadata.hasPendingWrites };
  }

  subscribeItems(
    contextId: Id,
    emit: (snapshot: CloudSnapshot<ItemRecord>) => void,
    fail: (error: Error) => void,
  ): Unsubscribe {
    const live = query(
      collection(this.#firestore, `users/${this.uid}/contexts/${contextId}/items`),
      where("deleting", "==", false),
    );
    let active = true;
    const unsubscribe = onSnapshot(live, { includeMetadataChanges: true }, (snapshot) => {
      const records = snapshot.docs.map((entry) => itemFromDocument(contextId, entry))
        .filter((value): value is ItemRecord => Boolean(value));
      emit({ records: sorted(records, false), fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
    }, (error) => {
      void isDeletedContextError(error, async () => {
        const contexts = await getDocsFromServer(liveDocumentQuery(collection(this.#firestore, `users/${this.uid}/contexts`), contextId));
        return contexts.docs.some(context => context.id === contextId);
      }).then(deleted => {
        if (!active) return;
        if (deleted) emit({ records: [], fromCache: false, hasPendingWrites: false });
        else fail(error);
      });
    });
    return () => { active = false; unsubscribe(); };
  }

  async refreshItems(contextId: Id): Promise<CloudSnapshot<ItemRecord>> {
    const live = query(collection(this.#firestore, `users/${this.uid}/contexts/${contextId}/items`), where("deleting", "==", false));
    const snapshot = await getDocsFromServer(live);
    const records = snapshot.docs.map(entry => itemFromDocument(contextId, entry))
      .filter((value): value is ItemRecord => Boolean(value));
    return { records: sorted(records, false), fromCache: false, hasPendingWrites: snapshot.metadata.hasPendingWrites };
  }

  async publish(record: QueuedShare): Promise<void> {
    try {
      await publishQueuedShare(record, this.#writePort());
    } catch (error) {
      throw cloudFailure(error);
    }
  }

  async renameContext(contextId: Id, title: string): Promise<void> {
    await updateDoc(doc(this.#firestore, `users/${this.uid}/contexts/${contextId}`), {
      title,
      titleState: "manual",
      updatedAt: serverTimestamp(),
    });
  }

  subscribeDeletedContexts(emit: (ids: Id[]) => void, fail: (error: Error) => void): Unsubscribe {
    return onSnapshot(collection(this.#firestore, `users/${this.uid}/deletedContexts`), snapshot => emit(snapshot.docs.map(d => d.id)), fail);
  }

  async refreshDeletedContexts(): Promise<Id[]> {
    const snapshot = await getDocsFromServer(collection(this.#firestore, `users/${this.uid}/deletedContexts`));
    return snapshot.docs.map(document => document.id as Id);
  }

  setNetworkEnabled(enabled: boolean): Promise<void> {
    const transition = this.#networkTransition.catch(() => undefined).then(async () => {
      // Firestore starts enabled. Re-enabling an active stream can register its
      // listen targets twice; only real foreground/background transitions touch it.
      if (this.#networkEnabled === enabled) return;
      await (enabled ? enableNetwork(this.#firestore) : disableNetwork(this.#firestore));
      this.#networkEnabled = enabled;
    });
    this.#networkTransition = transition;
    return transition;
  }

  subscribeDeletedItems(emit: (items: { contextId: Id; itemId: Id }[]) => void, fail: (error: Error) => void): Unsubscribe {
    return onSnapshot(collection(this.#firestore, `users/${this.uid}/deletedItems`), snapshot => emit(snapshot.docs.map(d => {
      const [contextId, itemId] = d.id.split("_"); return { contextId: contextId!, itemId: itemId! };
    })), fail);
  }
  async refreshDeletedItems(): Promise<{ contextId: Id; itemId: Id }[]> {
    const snapshot = await getDocsFromServer(collection(this.#firestore, `users/${this.uid}/deletedItems`));
    return snapshot.docs.map(document => {
      const [contextId, itemId] = document.id.split("_");
      return { contextId: contextId!, itemId: itemId! };
    });
  }
  async deletionMarkers() {
    const [contexts, items] = await Promise.all(["deletedContexts", "deletedItems"].map(name => getDocsFromServer(collection(this.#firestore, `users/${this.uid}/${name}`))));
    return { contexts: contexts!.docs.map(d => d.id), items: items!.docs.map(d => { const [contextId, itemId] = d.id.split("_"); return { contextId: contextId!, itemId: itemId! }; }) };
  }

  async getSettings(): Promise<{ aiTitlesEnabled: boolean }> { return (await this.#api("/api/settings", "GET")).json(); }
  async setSettings(aiTitlesEnabled: boolean): Promise<{ aiTitlesEnabled: boolean }> { return (await this.#api("/api/settings", "PATCH", { aiTitlesEnabled })).json(); }
  async listKeys(): Promise<AgentKeyInfo[]> { return (await this.#api("/api/agent-keys", "GET")).json(); }
  async createKey(name: string): Promise<AgentKeyInfo & { key: string }> { return (await this.#api("/api/agent-keys", "POST", { name })).json(); }
  async revokeKey(id: string): Promise<void> { await this.#api(`/api/agent-keys/${id}`, "DELETE"); }

  async deleteContext(contextId: Id): Promise<void> {
    await this.#api(`/api/contexts/${contextId}`, "DELETE");
  }

  async deleteItem(contextId: Id, itemId: Id): Promise<void> {
    await this.#api(`/api/contexts/${contextId}/items/${itemId}`, "DELETE");
  }

  async attachmentBytes(contextId: Id, itemId: Id, content: Extract<Content, { kind: "attachment" }>): Promise<Uint8Array> {
    const blob = await getBlob(ref(this.#storage, attachmentPath(this.uid, contextId, itemId)), content.size);
    if (blob.size !== content.size || (blob.type && blob.type !== content.contentType)) {
      throw new Error("Downloaded file metadata does not match the shared item");
    }
    return new Uint8Array(await blob.arrayBuffer());
  }

  async #api(path: string, method: "GET" | "POST" | "DELETE" | "PATCH", body?: unknown): Promise<Response> {
    const response = await fetch(apiUrl(path), {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new PublishFailure(response.status === 401 ? "Sign in again to continue" : "Cloud request failed", response.status >= 500 || response.status === 429, Math.min(3600, Math.max(0, Number(response.headers.get("retry-after")) || 0)) * 1000);
    return response;
  }

  #writePort(): CloudWritePort {
    const contextsPath = `users/${this.uid}/contexts`;
    const itemsPath = (contextId: Id) => `${contextsPath}/${contextId}/items`;
    const findContext = async (contextId: Id) => {
      const snapshot = await getDocs(liveDocumentQuery(collection(this.#firestore, contextsPath), contextId));
      return snapshot.docs.some((entry) => entry.id === contextId) ? { id: contextId } : undefined;
    };
    const findItem = async (contextId: Id, itemId: Id): Promise<ExistingItem | undefined> => {
      const snapshot = await getDocs(liveDocumentQuery(collection(this.#firestore, itemsPath(contextId)), itemId));
      const found = snapshot.docs.find((entry) => entry.id === itemId);
      if (!found) return undefined;
      const data = found.data();
      const content = ContentSchema.safeParse(data.content);
      const device = DeviceSchema.safeParse(data.device);
      if (!content.success || !device.success || typeof data.ready !== "boolean") {
        throw new PublishFailure("Cloud item data is invalid", false);
      }
      return { content: content.data, device: device.data, ready: data.ready };
    };
    const itemData = (record: QueuedShare) => ({
      content: record.content,
      device: record.device,
      createdAt: serverTimestamp(),
      ready: record.content.kind !== "attachment",
      deleting: false,
    });
    return {
      findContext,
      findItem,
      createInitial: async (record) => {
        const batch = writeBatch(this.#firestore);
        const timestamp = serverTimestamp();
        batch.set(doc(this.#firestore, contextsPath, record.contextId), {
          title: record.title, createdAt: timestamp, updatedAt: timestamp, deleting: false,
          originDeviceId: record.device.id, firstItemId: record.itemId, ready: record.content.kind !== "attachment", titleState: record.manualTitle ? "manual" : "pending",
        });
        batch.set(doc(this.#firestore, itemsPath(record.contextId), record.itemId), itemData(record));
        await batch.commit();
      },
      append: async (record) => {
        const batch = writeBatch(this.#firestore);
        batch.set(doc(this.#firestore, itemsPath(record.contextId), record.itemId), itemData(record));
        batch.update(doc(this.#firestore, contextsPath, record.contextId), { updatedAt: serverTimestamp() });
        await batch.commit();
      },
      completeAttachment: async (record) => {
        const response = await fetch(apiUrl(`/api/contexts/${record.contextId}/items/${record.itemId}/complete`), {
          method: "POST",
          headers: { authorization: `Bearer ${await this.accessToken()}` },
        });
        if (response.ok) return "complete";
        if (response.status === 404) return "missing";
        throw new PublishFailure(response.status === 401 ? "Sign in again to continue" : "File completion failed", response.status >= 500 || response.status === 429, Math.min(3600, Math.max(0, Number(response.headers.get("retry-after")) || 0)) * 1000);
      },
      upload: async (record, bytes) => {
        await uploadBytes(
          ref(this.#storage, attachmentPath(this.uid, record.contextId, record.itemId)),
          bytes,
          { contentType: record.content.kind === "attachment" ? record.content.contentType : "application/octet-stream" },
        );
      },
    };
  }
}
