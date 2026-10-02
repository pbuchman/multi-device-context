import { openLocalDatabase, changed } from "./local-db.js";
import type { Id } from "@mdc/contracts";

import type { ShareDraft } from "./model.js";

export type AccountNamespace = { projectId: string; uid: string };

export type QueuedShare = ShareDraft & {
  key: string;
  namespace: string;
  attempts: number;
  queuedAt: number;
  nextAttemptAt: number;
  status: "pending" | "failed" | "paused";
  lastError?: string;
};

type NativeMarker = {
  key: string;
  kind: "native";
  namespace: string;
  requestId: Id;
};

type StoredAction = QueuedShare & { kind: "action" };
type DeletedMarker = { key: string; kind: "deleted"; namespace: string; contextId: Id };
export type Deletion = { key: string; kind: "deletion"; namespace: string; contextId: Id; itemId?: Id; nextAttemptAt: number; attempts: number; paused: boolean };
type ItemMarker = { key: string; kind: "deleted-item"; namespace: string; contextId: Id; itemId: Id };
type StoredRecord = StoredAction | NativeMarker | DeletedMarker | ItemMarker | Deletion;

const STORE_NAME = "records";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

const openDatabase = openLocalDatabase;

function cleanMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 240) : "Sharing failed";
}

export class DurableOutbox {
  readonly namespace: string;
  #database: Promise<IDBDatabase> | undefined;

  constructor(account: AccountNamespace) {
    this.namespace = `${account.projectId}:${account.uid}`;
  }

  #db(): Promise<IDBDatabase> {
    this.#database ??= openDatabase();
    return this.#database;
  }

  async enqueue(draft: ShareDraft): Promise<void> { await this.enqueueBatch([draft]); }
  async enqueueBatch(drafts: ShareDraft[]): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite"); const complete = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    try {
      for (const draft of drafts) {
        if (await requestResult(store.get(`deleted:${this.namespace}:${draft.contextId}`)) || await requestResult(store.get(`deleted-item:${this.namespace}:${draft.contextId}:${draft.itemId}`))) throw new PublishFailure("This context or item was deleted", false);
        store.put({ ...draft, key: `action:${this.namespace}:${draft.itemId}`, kind: "action", namespace: this.namespace, attempts: 0, queuedAt: Date.now(), nextAttemptAt: 0, status: "pending" } satisfies StoredAction);
      }
      await complete; changed();
    } catch (error) {
      try { transaction.abort(); } catch { /* Already aborted by IndexedDB (quota, clone, etc.). */ }
      await complete.catch(() => {}); throw error;
    }
  }

  async enqueueNativeRequest(requestId: Id, drafts: ShareDraft[]): Promise<boolean> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const markerKey = `native:${this.namespace}:${requestId}`;
    const marker = await requestResult(store.get(markerKey) as IDBRequest<StoredRecord | undefined>);
    if (marker) {
      transaction.abort();
      try { await transactionDone(transaction); } catch { /* expected abort */ }
      return false;
    }
    store.add({ key: markerKey, kind: "native", namespace: this.namespace, requestId } satisfies NativeMarker);
    for (const draft of drafts) {
      if (await requestResult(store.get(`deleted:${this.namespace}:${draft.contextId}`)) || await requestResult(store.get(`deleted-item:${this.namespace}:${draft.contextId}:${draft.itemId}`))) continue;
      store.add({
        ...draft,
        key: `action:${this.namespace}:${draft.itemId}`,
        kind: "action",
        namespace: this.namespace,
        attempts: 0,
        queuedAt: Date.now(),
        nextAttemptAt: 0,
        status: "pending",
      } satisfies StoredAction);
    }
    await transactionDone(transaction);
    return true;
  }

  async hasNativeRequest(requestId: Id): Promise<boolean> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestResult(
      transaction.objectStore(STORE_NAME).get(`native:${this.namespace}:${requestId}`),
    );
    await transactionDone(transaction);
    return record !== undefined;
  }

  async markNativeAcknowledged(requestId: Id): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(`native:${this.namespace}:${requestId}`);
    await transactionDone(transaction);
  }

  async list(): Promise<QueuedShare[]> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestResult(
      transaction.objectStore(STORE_NAME).index("namespace").getAll(this.namespace),
    ) as StoredRecord[];
    await transactionDone(transaction);
    const groups = new Map<string, StoredAction[]>();
    for (const record of records) {
      if (record.kind !== "action" || records.some(r => r.kind === "deletion" && r.contextId === record.contextId)) continue;
      const group = groups.get(record.contextId) ?? [];
      group.push(record);
      groups.set(record.contextId, group);
    }
    return [...groups.values()]
      .sort((left, right) => {
        const queued = Math.min(...left.map((record) => record.queuedAt))
          - Math.min(...right.map((record) => record.queuedAt));
        if (queued) return queued;
        return left[0]!.contextId.localeCompare(right[0]!.contextId);
      })
      .flatMap((group) => group.sort((left, right) => {
        if (left.createsContext !== right.createsContext) return left.createsContext ? -1 : 1;
        const queued = left.queuedAt - right.queuedAt;
        return queued || left.key.localeCompare(right.key);
      }));
  }

  async removeContext(id: Id): Promise<void> { await this.cancel(id); }
  async removeItem(contextId: Id, itemId: Id): Promise<void> { await this.cancel(contextId, itemId); }
  async requestDeletion(contextId: Id, itemId?: Id): Promise<void> { await this.cancel(contextId, itemId, true); }
  private async cancel(contextId: Id, itemId?: Id, request = false): Promise<void> {
    const db = await this.#db();
    const tx = db.transaction([STORE_NAME, "drafts"], "readwrite"); const complete = transactionDone(tx);
    const store = tx.objectStore(STORE_NAME);
    const records = await requestResult(store.index("namespace").getAll(this.namespace)) as StoredRecord[];
    const actions = records.filter((r): r is StoredAction => r.kind === "action" && r.contextId === contextId);
    const removed = actions.filter(r => !itemId || r.itemId === itemId);
    for (const record of removed) store.delete(record.key);
    if (itemId) {
      store.put({ key: `deleted-item:${this.namespace}:${contextId}:${itemId}`, kind: "deleted-item", namespace: this.namespace, contextId, itemId } satisfies ItemMarker);
      if (removed.some(r => r.createsContext)) {
        const next = actions.filter(r => r.itemId !== itemId).sort((a,b) => a.queuedAt - b.queuedAt || a.itemId.localeCompare(b.itemId))[0];
        if (next) store.put({ ...next, createsContext: true });
      }
    } else {
      tx.objectStore("drafts").delete(`draft:${this.namespace}:${contextId}`);
      store.put({ key: `deleted:${this.namespace}:${contextId}`, kind: "deleted", namespace: this.namespace, contextId } satisfies DeletedMarker);
      for (const record of records) if (record.kind === "deletion" && record.contextId === contextId && record.itemId) store.delete(record.key);
    }
    if (request) store.put({ key: `deletion:${this.namespace}:${contextId}:${itemId ?? "context"}`, kind: "deletion", namespace: this.namespace, contextId, ...(itemId ? { itemId } : {}), attempts: 0, nextAttemptAt: 0, paused: false } satisfies Deletion);
    await complete; changed();
  }
  async cancelled(): Promise<{ contexts: Id[]; items: Id[] }> {
    const db = await this.#db(); const tx = db.transaction(STORE_NAME, "readonly");
    const records = await requestResult(tx.objectStore(STORE_NAME).index("namespace").getAll(this.namespace)) as StoredRecord[];
    return { contexts: records.filter((r): r is DeletedMarker => r.kind === "deleted").map(r => r.contextId), items: records.filter((r): r is ItemMarker => r.kind === "deleted-item").map(r => r.itemId) };
  }
  async deletions(): Promise<Deletion[]> {
    const db = await this.#db(); const tx = db.transaction(STORE_NAME, "readonly");
    const records = await requestResult(tx.objectStore(STORE_NAME).index("namespace").getAll(this.namespace)) as StoredRecord[];
    return records.filter((r): r is Deletion => r.kind === "deletion");
  }
  async failDeletion(record: Deletion, paused: boolean, retryAfterMs = 0) {
    const db = await this.#db(); const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    if (await requestResult(store.get(record.key))) store.put({ ...record, paused, attempts: record.attempts + 1, nextAttemptAt: Date.now() + Math.max(retryAfterMs, Math.min(60_000, 1000 * 2 ** Math.min(record.attempts, 6))) });
    await transactionDone(tx); changed();
  }
  async isCancelled(record: QueuedShare): Promise<boolean> {
    const db = await this.#db(); const tx = db.transaction(STORE_NAME, "readonly");
    return !await requestResult(tx.objectStore(STORE_NAME).get(record.key));
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  async remove(key: string): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    await transactionDone(transaction); changed();
  }

  async markAttempting(record: QueuedShare): Promise<boolean> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const current = await requestResult(transaction.objectStore(STORE_NAME).get(record.key));
    if (!current) { await transactionDone(transaction); return false; }
    transaction.objectStore(STORE_NAME).put({
      ...current,
      kind: "action",
      attempts: current.attempts + 1,
      status: "pending",
    } satisfies StoredAction);
    await transactionDone(transaction); return true;
  }

  async markFailed(record: QueuedShare, error: unknown, delayMs: number, paused: boolean): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    if (!await requestResult(transaction.objectStore(STORE_NAME).get(record.key))) { await transactionDone(transaction); return; }
    transaction.objectStore(STORE_NAME).put({
      ...record,
      kind: "action",
      attempts: record.attempts + 1,
      nextAttemptAt: paused ? Number.MAX_SAFE_INTEGER : Date.now() + delayMs,
      status: paused ? "paused" : "failed",
      lastError: cleanMessage(error),
    } satisfies StoredAction);
    await transactionDone(transaction);
  }

  async retry(key?: string): Promise<void> {
    const database = await this.#db();
    const records = (await requestResult(database.transaction(STORE_NAME).objectStore(STORE_NAME).index("namespace").getAll(this.namespace)) as StoredRecord[]).filter((r): r is StoredAction | Deletion => r.kind === "action" || r.kind === "deletion");
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const record of records) {
      if ((!key || record.key === key) && await requestResult(store.get(record.key))) {
        store.put({ ...record, status: "pending", paused: false, nextAttemptAt: 0, lastError: undefined });
      }
    }
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const records = await requestResult(store.index("namespace").getAll(this.namespace)) as StoredRecord[];
    for (const record of records) store.delete(record.key);
    await transactionDone(transaction);
  }

  close(): void {
    if (this.#database) void this.#database.then((database) => database.close());
    this.#database = undefined;
  }
}

export class PublishFailure extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0) {
    super(message);
  }
}

export type PublishPort = { publish(record: QueuedShare): Promise<void>; prepare?(): Promise<void> };

export class OutboxRunner {
  #retryAfter = 0;
  #running = false;
  #stopped = false;
  #drainRequested = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #idleWaiters = new Set<() => void>();
  constructor(
    private readonly outbox: DurableOutbox,
    private readonly port: PublishPort,
    private readonly options: { baseDelayMs?: number; maxDelayMs?: number } = {},
  ) {}

  async drain(): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(`mdc-publish:${this.outbox.namespace}`, () => this.#drain());
    return this.#drain();
  }
  async #drain(): Promise<void> {
    if (this.#stopped) return;
    if (this.#running) {
      this.#drainRequested = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#running = true;
    try {
      do {
        this.#drainRequested = false;
        await this.port.prepare?.();
        const records = await this.outbox.list();
        const pendingCreators = new Set(records.filter((record) => record.createsContext).map((record) => record.contextId));
        for (const record of records) {
          if (this.#stopped) return;
          if (!record.createsContext && pendingCreators.has(record.contextId)) continue;
          if (record.status === "paused" || record.nextAttemptAt > Date.now()) continue;
          if (!await this.outbox.markAttempting(record)) continue;
          if (this.#stopped) return;
          try {
            await this.port.publish(record);
            if (this.#stopped) return;
            await this.outbox.remove(record.key);
            if (record.createsContext) pendingCreators.delete(record.contextId);
          } catch (error) {
            if (this.#stopped) return;
            const retryable = !(error instanceof PublishFailure) || error.retryable;
            const base = this.options.baseDelayMs ?? 1_000;
            const maximum = this.options.maxDelayMs ?? 60_000;
            const delay = Math.max(error instanceof PublishFailure ? error.retryAfterMs : 0, Math.min(maximum, base * 2 ** Math.min(record.attempts, 6)));
            await this.outbox.markFailed(record, error, delay, !retryable);
            break;
          }
        }
      } while (!this.#stopped && this.#drainRequested);
    } catch (error) { this.#retryAfter = Date.now() + 1000; throw error; } finally {
      try {
        if (!this.#stopped) await this.#scheduleRemaining();
      } finally {
        this.#running = false;
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
        if (!this.#stopped && this.#drainRequested) {
          this.#drainRequested = false;
          void this.drain().catch(() => {});
        }
      }
    }
  }

  async #scheduleRemaining(): Promise<void> {
    const records = await this.outbox.list();
    if (this.#stopped) return;
    const pendingCreators = new Set(records.filter((record) => record.createsContext).map((record) => record.contextId));
    const eligible = records.filter((record) =>
      record.status !== "paused"
      && (record.createsContext || !pendingCreators.has(record.contextId)));
    const deletions = (await this.outbox.deletions()).filter(d => !d.paused);
    if (eligible.length + deletions.length === 0) return;
    const nextAttemptAt = Math.min(...[...eligible, ...deletions].map((record) => record.nextAttemptAt));
    const maximum = this.options.maxDelayMs ?? 60_000;
    const delay = Math.min(maximum, Math.max(0, Math.max(this.#retryAfter, nextAttemptAt) - Date.now()) + 1);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.drain().catch(() => {});
    }, delay);
  }

  stop(): void {
    this.#stopped = true;
    this.#drainRequested = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  get stopped(): boolean { return this.#stopped; }

  async stopAndWait(): Promise<void> {
    this.stop();
    if (this.#running) await new Promise<void>(resolve => this.#idleWaiters.add(resolve));
  }

  resume(): void {
    this.#stopped = false;
    void this.drain().catch(() => {});
  }
}
