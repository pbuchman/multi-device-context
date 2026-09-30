import { afterEach, describe, expect, it, vi } from "vitest";

import { FirebaseBackend } from "./firebase.js";
import { BackendConflictError, BackendNotFoundError } from "./server.js";

const CONTEXT_ID = "00000000-0000-4000-8000-000000000001";
const ITEM_ID = "00000000-0000-4000-8000-000000000002";
const UID = "owner_uid";

type Stored = Record<string, unknown>;

class FakeSnapshot {
  constructor(
    readonly ref: FakeDocumentReference,
    readonly stored: Stored | undefined,
  ) {}
  get exists() {
    return this.stored !== undefined;
  }
  get id() {
    return this.ref.id;
  }
  data() {
    return this.stored;
  }
}

class FakeQuery {
  private maximum = Number.POSITIVE_INFINITY;
  private deletingOnly = false;
  constructor(
    private readonly store: FakeFirestore,
    private readonly matches: (path: string) => boolean,
  ) {}
  where(field: string, operator: string, value: unknown) {
    if (field === "deleting" && operator === "==" && value === true) this.deletingOnly = true;
    return this;
  }
  limit(maximum: number) {
    this.maximum = maximum;
    return this;
  }
  async get() {
    const docs = [...this.store.documents.entries()]
      .filter(([path, data]) => this.matches(path) && (!this.deletingOnly || data.deleting === true))
      .slice(0, this.maximum)
      .map(([path, data]) => new FakeSnapshot(this.store.doc(path), data));
    return { docs, empty: docs.length === 0 };
  }
}

class FakeDocumentReference {
  constructor(
    private readonly store: FakeFirestore,
    readonly path: string,
  ) {}
  get id() {
    return this.path.split("/").at(-1)!;
  }
  async get() {
    return new FakeSnapshot(this, this.store.documents.get(this.path));
  }
  async set(data: Stored, options?: { merge?: boolean }) {
    const previous = this.store.documents.get(this.path);
    this.store.documents.set(this.path, options?.merge ? { ...previous, ...data } : { ...data });
  }
  async update(data: Stored) {
    const previous = this.store.documents.get(this.path);
    if (!previous) throw new Error("missing document");
    this.store.documents.set(this.path, { ...previous, ...data });
  }
  async delete() {
    this.store.documents.delete(this.path);
  }
  collection(name: string) {
    const prefix = `${this.path}/${name}/`;
    return new FakeQuery(
      this.store,
      (path) => path.startsWith(prefix) && path.slice(prefix.length).split("/").length === 1,
    );
  }
}

class FakeFirestore {
  readonly documents = new Map<string, Stored>();
  readonly requestedPaths: string[] = [];
  doc(path: string) {
    this.requestedPaths.push(path);
    return new FakeDocumentReference(this, path);
  }
  async runTransaction<T>(callback: (transaction: {
    get(ref: FakeDocumentReference): Promise<FakeSnapshot>;
    update(ref: FakeDocumentReference, data: Stored): void;
    set(ref: FakeDocumentReference, data: Stored): void;
  }) => Promise<T>) {
    const updates: Array<[FakeDocumentReference, Stored]> = [];
    const sets: Array<[FakeDocumentReference, Stored]> = [];
    const result = await callback({
      get: (ref) => ref.get(),
      update: (ref, data) => updates.push([ref, data]),
      set: (ref, data) => sets.push([ref, data]),
    });
    for (const [ref, data] of updates) await ref.update(data);
    for (const [ref, data] of sets) await ref.set(data);
    return result;
  }
  collectionGroup(name: string) {
    return new FakeQuery(this, (path) => {
      const segments = path.split("/");
      return segments.length >= 2 && segments.at(-2) === name;
    });
  }
}

type FakeObject = {
  size: number;
  contentType: string;
  generation: string;
  failDeletes?: number;
  customMetadata?: Record<string, string>;
  failMetadataUpdate?: boolean;
};

class FakeFile {
  constructor(
    private readonly bucket: FakeBucket,
    readonly name: string,
    readonly metadata: { generation: string },
  ) {}
  async getMetadata() {
    const object = this.bucket.objects.get(this.name);
    if (!object) throw Object.assign(new Error("missing"), { code: 404 });
    return [{ size: String(object.size), contentType: object.contentType, generation: object.generation, metadata: object.customMetadata }];
  }
  async setMetadata(value: { metadata: Record<string, string | null> }) {
    const object = this.bucket.objects.get(this.name);
    if (!object) throw Object.assign(new Error("missing"), { code: 404 });
    if (object.failMetadataUpdate) throw new Error("metadata update failed");
    for (const [key, entry] of Object.entries(value.metadata)) {
      if (entry === null) delete object.customMetadata?.[key];
      else (object.customMetadata ??= {})[key] = entry;
    }
    return this.getMetadata();
  }
  async delete() {
    const object = this.bucket.objects.get(this.name);
    if (!object) return;
    if ((object.failDeletes ?? 0) > 0) {
      object.failDeletes = (object.failDeletes ?? 0) - 1;
      throw new Error("transient delete failure");
    }
    this.bucket.objects.delete(this.name);
  }
}

class FakeBucket {
  readonly objects = new Map<string, FakeObject>();
  metadataReads = 0;
  bucketMetadataReads = 0;
  file(name: string) {
    const generation = this.objects.get(name)?.generation ?? "0";
    const file = new FakeFile(this, name, { generation });
    const originalGetMetadata = file.getMetadata.bind(file);
    file.getMetadata = async () => {
      this.metadataReads += 1;
      return originalGetMetadata();
    };
    return file;
  }
  async getFiles(options: { prefix: string; maxResults: number; pageToken?: string }) {
    const names = [...this.objects.keys()].filter((name) => name.startsWith(options.prefix)).sort();
    const start = options.pageToken ? Number(options.pageToken) : 0;
    const selected = names.slice(start, start + options.maxResults);
    const next = start + selected.length < names.length ? String(start + selected.length) : undefined;
    return [
      selected.map((name) => {
        const object = this.objects.get(name)!;
        return new FakeFile(this, name, { generation: object.generation });
      }),
      next ? { ...options, pageToken: next } : null,
    ];
  }
  async getMetadata() {
    this.bucketMetadataReads += 1;
    return [{}];
  }
}

function fixture() {
  const firestore = new FakeFirestore();
  const bucket = new FakeBucket();
  const auth = { createCustomToken: vi.fn(async (uid: string) => `custom:${uid}`) };
  const backend = new FirebaseBackend({
    firestore: firestore as never,
    bucket: bucket as never,
    auth: auth as never,
    cleanupIntervalMs: 60_000,
  });
  return { backend, firestore, bucket, auth };
}

function paths() {
  const context = `users/${UID}/contexts/${CONTEXT_ID}`;
  const item = `${context}/items/${ITEM_ID}`;
  const object = `${item}/original`;
  return { context, item, object };
}

afterEach(() => vi.restoreAllMocks());

describe("FirebaseBackend upload completion", () => {
  it("verifies exact immutable attachment metadata and completes idempotently", async () => {
    const { backend, firestore, bucket } = fixture();
    const { context, item, object } = paths();
    firestore.documents.set(context, { deleting: false });
    firestore.documents.set(item, {
      content: { kind: "attachment", name: "report.pdf", contentType: "application/pdf", size: 12 },
      ready: false,
      deleting: false,
    });
    bucket.objects.set(object, { size: 12, contentType: "application/pdf", generation: "7", customMetadata: { firebaseStorageDownloadTokens: "synthetic-token" } });

    await backend.completeUpload(UID, CONTEXT_ID, ITEM_ID);
    expect(firestore.documents.get(item)?.ready).toBe(true);
    expect(bucket.objects.get(object)?.customMetadata?.firebaseStorageDownloadTokens).toBeUndefined();
    const readsAfterCompletion = bucket.metadataReads;
    await backend.completeUpload(UID, CONTEXT_ID, ITEM_ID);
    expect(bucket.metadataReads).toBe(readsAfterCompletion);
  });

  it("keeps an attachment unavailable if download-token removal fails", async () => {
    const { backend, firestore, bucket } = fixture();
    const { context, item, object } = paths();
    firestore.documents.set(context, { deleting: false });
    firestore.documents.set(item, {
      content: { kind: "attachment", name: "report.pdf", contentType: "application/pdf", size: 12 },
      ready: false, deleting: false,
    });
    bucket.objects.set(object, { size: 12, contentType: "application/pdf", generation: "7", failMetadataUpdate: true, customMetadata: { firebaseStorageDownloadTokens: "synthetic-token" } });
    await expect(backend.completeUpload(UID, CONTEXT_ID, ITEM_ID)).rejects.toThrow("metadata update failed");
    expect(firestore.documents.get(item)?.ready).toBe(false);
  });

  it("returns not found when deletion races with download-token removal", async () => {
    const { backend, firestore, bucket } = fixture();
    const { context, item, object } = paths();
    firestore.documents.set(context, { deleting: false });
    firestore.documents.set(item, {
      content: { kind: "attachment", name: "report.pdf", contentType: "application/pdf", size: 12 },
      ready: false, deleting: false,
    });
    bucket.objects.set(object, { size: 12, contentType: "application/pdf", generation: "7" });
    const originalFile = bucket.file.bind(bucket);
    bucket.file = (name: string) => {
      const file = originalFile(name);
      const originalRead = file.getMetadata.bind(file);
      file.getMetadata = async () => {
        const metadata = await originalRead();
        bucket.objects.delete(name);
        return metadata;
      };
      return file;
    };
    await expect(backend.completeUpload(UID, CONTEXT_ID, ITEM_ID)).rejects.toBeInstanceOf(BackendNotFoundError);
    expect(firestore.documents.get(item)?.ready).toBe(false);
  });

  it("returns not found for an absent object and conflict for mismatch or deletion", async () => {
    const { backend, firestore, bucket } = fixture();
    const { context, item, object } = paths();
    firestore.documents.set(context, { deleting: false });
    firestore.documents.set(item, {
      content: { kind: "attachment", name: "report.pdf", contentType: "application/pdf", size: 12 },
      ready: false,
      deleting: false,
    });
    await expect(backend.completeUpload(UID, CONTEXT_ID, ITEM_ID)).rejects.toBeInstanceOf(
      BackendNotFoundError,
    );
    bucket.objects.set(object, { size: 13, contentType: "application/pdf", generation: "7" });
    await expect(backend.completeUpload(UID, CONTEXT_ID, ITEM_ID)).rejects.toBeInstanceOf(
      BackendConflictError,
    );
    bucket.objects.set(object, { size: 12, contentType: "text/plain", generation: "7" });
    await expect(backend.completeUpload(UID, CONTEXT_ID, ITEM_ID)).rejects.toBeInstanceOf(
      BackendConflictError,
    );
    firestore.documents.set(context, { deleting: true });
    await expect(backend.completeUpload(UID, CONTEXT_ID, ITEM_ID)).rejects.toBeInstanceOf(
      BackendConflictError,
    );
    expect(firestore.documents.get(item)?.ready).toBe(false);
  });
});

describe("FirebaseBackend deletion", () => {
  it("records absent deletions to reject a delayed create after DELETE returns", async () => {
    const { backend, firestore } = fixture();
    await backend.deleteContext(UID, CONTEXT_ID);
    await backend.deleteItem(UID, CONTEXT_ID, ITEM_ID);
    expect(firestore.documents.get(`users/${UID}/deletedContexts/${CONTEXT_ID}`)).toEqual({ deleted: true });
    expect(firestore.documents.get(`users/${UID}/deletedItems/${CONTEXT_ID}_${ITEM_ID}`)).toEqual({ deleted: true });
  });
  it("persists tombstones and resumes context cleanup after an interrupted object delete", async () => {
    const { backend, firestore, bucket } = fixture();
    const { context, item, object } = paths();
    firestore.documents.set(context, { deleting: false });
    firestore.documents.set(item, { deleting: false });
    bucket.objects.set(object, {
      size: 12,
      contentType: "application/pdf",
      generation: "7",
      failDeletes: 1,
    });
    bucket.objects.set(`${item}/unexpected-generation-copy`, {
      size: 12,
      contentType: "application/pdf",
      generation: "3",
    });

    await expect(backend.deleteContext(UID, CONTEXT_ID)).rejects.toThrow("transient");
    expect(firestore.documents.get(context)?.deleting).toBe(true);
    expect(firestore.documents.get(`users/${UID}/deletedContexts/${CONTEXT_ID}`)).toEqual({ deleted: true });
    expect(firestore.documents.get(item)?.deleting).toBe(true);

    await backend.deleteContext(UID, CONTEXT_ID);
    expect(firestore.documents.has(context)).toBe(false);
    expect(firestore.documents.get(`users/${UID}/deletedContexts/${CONTEXT_ID}`)).toEqual({ deleted: true });
    expect(firestore.documents.has(item)).toBe(false);
    expect([...bucket.objects.keys()].some((name) => name.startsWith(`${context}/`))).toBe(false);
    await expect(backend.deleteContext(UID, CONTEXT_ID)).resolves.toBeUndefined();
  });

  it("deletes only the authenticated item's exact prefix and is idempotent", async () => {
    const { backend, firestore, bucket } = fixture();
    const { context, item, object } = paths();
    firestore.documents.set(context, { deleting: false });
    firestore.documents.set(item, { deleting: false });
    bucket.objects.set(object, { size: 1, contentType: "text/plain", generation: "1" });
    const other = `users/other_uid/contexts/${CONTEXT_ID}/items/${ITEM_ID}/original`;
    bucket.objects.set(other, { size: 1, contentType: "text/plain", generation: "1" });

    await backend.deleteItem(UID, CONTEXT_ID, ITEM_ID);
    expect(bucket.objects.has(object)).toBe(false);
    expect(firestore.documents.get(`users/${UID}/deletedItems/${CONTEXT_ID}_${ITEM_ID}`)).toEqual({ deleted: true });
    expect(bucket.objects.has(other)).toBe(true);
    await expect(backend.deleteItem(UID, CONTEXT_ID, ITEM_ID)).resolves.toBeUndefined();
  });
});

describe("FirebaseBackend readiness", () => {
  it("checks a valid internal Firestore document path and bucket metadata", async () => {
    const { backend, firestore, bucket } = fixture();
    await backend.checkReady();
    expect(firestore.requestedPaths).toContain("internalHealth/readiness");
    expect(firestore.requestedPaths).not.toContain("__health__/readiness");
    expect(bucket.bucketMetadataReads).toBe(1);
  });
});
