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
type StoredRecord = StoredAction | NativeMarker | DeletedMarker;

const DATABASE_NAME = "mdc-outbox-v1";
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex("namespace", "namespace", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the local outbox"));
  });
}

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

  async enqueue(draft: ShareDraft): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const record: StoredAction = {
      ...draft,
      key: `action:${this.namespace}:${draft.itemId}`,
      kind: "action",
      namespace: this.namespace,
      attempts: 0,
      queuedAt: Date.now(),
      nextAttemptAt: 0,
      status: "pending",
    };
    const marker = await requestResult(transaction.objectStore(STORE_NAME).get(`deleted:${this.namespace}:${draft.contextId}`));
    if (marker) throw new PublishFailure("This context was deleted", false);
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
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
      if (await requestResult(store.get(`deleted:${this.namespace}:${draft.contextId}`))) continue;
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
      if (record.kind !== "action") continue;
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

  async removeContext(id: Id): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const records = await requestResult(store.index("namespace").getAll(this.namespace)) as StoredRecord[];
    for (const record of records) if (record.kind === "action" && record.contextId === id) store.delete(record.key);
    store.put({ key: `deleted:${this.namespace}:${id}`, kind: "deleted", namespace: this.namespace, contextId: id } satisfies DeletedMarker);
    await transactionDone(transaction);
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  async remove(key: string): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    await transactionDone(transaction);
  }

  async markAttempting(record: QueuedShare): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    if (!await requestResult(transaction.objectStore(STORE_NAME).get(record.key))) { await transactionDone(transaction); return; }
    transaction.objectStore(STORE_NAME).put({
      ...record,
      kind: "action",
      attempts: record.attempts + 1,
      status: "pending",
    } satisfies StoredAction);
    await transactionDone(transaction);
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
    const records = await this.list();
    const database = await this.#db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const record of records) {
      if ((!key || record.key === key) && await requestResult(store.get(record.key))) {
        store.put({ ...record, status: "pending", nextAttemptAt: 0, lastError: undefined });
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
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export type PublishPort = { publish(record: QueuedShare): Promise<void> };

export class OutboxRunner {
  #running = false;
  #stopped = false;
  #drainRequested = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly outbox: DurableOutbox,
    private readonly port: PublishPort,
    private readonly options: { baseDelayMs?: number; maxDelayMs?: number } = {},
  ) {}

  async drain(): Promise<void> {
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
        const records = await this.outbox.list();
        const pendingCreators = new Set(records.filter((record) => record.createsContext).map((record) => record.contextId));
        for (const record of records) {
          if (this.#stopped) return;
          if (!record.createsContext && pendingCreators.has(record.contextId)) continue;
          if (record.status === "paused" || record.nextAttemptAt > Date.now()) continue;
          await this.outbox.markAttempting(record);
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
            const delay = Math.min(maximum, base * 2 ** Math.min(record.attempts, 6));
            await this.outbox.markFailed(record, error, delay, !retryable);
            break;
          }
        }
      } while (!this.#stopped && this.#drainRequested);
    } finally {
      try {
        if (!this.#stopped) await this.#scheduleRemaining();
      } finally {
        this.#running = false;
        if (!this.#stopped && this.#drainRequested) {
          this.#drainRequested = false;
          void this.drain();
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
    if (eligible.length === 0) return;
    const nextAttemptAt = Math.min(...eligible.map((record) => record.nextAttemptAt));
    const maximum = this.options.maxDelayMs ?? 60_000;
    const delay = Math.min(maximum, Math.max(0, nextAttemptAt - Date.now()) + 1);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.drain();
    }, delay);
  }

  stop(): void {
    this.#stopped = true;
    this.#drainRequested = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  resume(): void {
    this.#stopped = false;
    void this.drain();
  }
}
