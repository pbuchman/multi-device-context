import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { AgentStore } from "./agent-store.js";
import { FirebaseBackend } from "./firebase.js";
import { AccountSettings } from "./settings.js";
import { TitleWorker } from "./titles.js";
import { BackendConflictError, BackendNotFoundError } from "./server.js";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error("Emulators required");
const app = initializeApp({ projectId: "demo-mdc", storageBucket: "demo-mdc.appspot.com" }, "agent-integration");
const db = getFirestore(app); const bucket = getStorage(app).bucket();
const backend = new FirebaseBackend({ firestore: db, bucket, auth: getAuth(app) });
const store = new AgentStore(db, bucket, backend);
const owner = "agent-integration-owner"; const other = "agent-integration-other";
const content = { kind: "text" as const, text: "Prepare context sharing release" };
beforeAll(async () => { await db.recursiveDelete(db.doc(`users/${owner}`)); });
afterAll(async () => {
  vi.unstubAllGlobals(); await db.recursiveDelete(db.doc(`users/${owner}`));
  for (const doc of (await db.collection("agentKeys").where("uid", "==", owner).get()).docs) await doc.ref.delete();
  await bucket.deleteFiles({ prefix: `users/${owner}/` }); await deleteApp(app);
});
describe("agent persistence and title races", () => {
  it("stores only key hashes, isolates owners, and revokes immediately", async () => {
    const key = await store.createKey(owner, "Integration");
    expect((await db.doc(`agentKeys/${key.id}`).get()).data()).not.toHaveProperty("key");
    expect(JSON.stringify(await store.listKeys(owner))).not.toContain(key.key);
    expect(await store.authenticate(key.key)).toEqual({ uid: owner, keyId: key.id });
    await store.revokeKey(other, key.id); expect(await store.authenticate(key.key)).toBeTruthy();
    await store.revokeKey(owner, key.id); expect(await store.authenticate(key.key)).toBeUndefined();
  });
  it("paginates without skips and prevents replay from resurrecting deleted content", async () => {
    const id = randomUUID(); const item = { id: randomUUID(), content };
    await store.writeItem(owner, id, item, true); await store.writeItem(owner, id, item, true);
    expect((await store.listItems(owner, id)).records).toHaveLength(1);
    await expect(store.getContext(other, id)).rejects.toBeInstanceOf(BackendNotFoundError);
    await expect(store.writeItem(owner, id, { ...item, content: { kind: "text", text: "different" } }, true)).rejects.toBeInstanceOf(BackendConflictError);
    const second = randomUUID(); await store.writeItem(owner, second, { id: randomUUID(), content }, true);
    const firstPage = await store.listContexts(owner, undefined, 1); const secondPage = await store.listContexts(owner, firstPage.cursor!, 1);
    expect(firstPage.records[0]!.id).not.toBe(secondPage.records[0]!.id);
    await backend.deleteContext(owner, id); await expect(store.writeItem(owner, id, item, true)).rejects.toBeInstanceOf(BackendNotFoundError);
  });
  it("streams files, enforces size, finalizes the first attachment and deletes originals", async () => {
    const id = randomUUID(); const itemId = randomUUID();
    await store.writeItem(owner, id, { id: itemId, content: { kind: "attachment", name: "test.bin", contentType: "application/octet-stream", size: 3 } }, true);
    await expect(store.upload(owner, id, itemId, Readable.from([Buffer.from([1, 2])]))).rejects.toBeTruthy();
    await store.upload(owner, id, itemId, Readable.from([Buffer.from([0, 255, 1])]));
    expect((await store.getContext(owner, id)).ready).toBe(true);
    const download = await store.download(owner, id, itemId); const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1]));
    await expect(store.upload(owner, id, itemId, Readable.from([Buffer.from([0, 255, 1])]))).rejects.toBeInstanceOf(BackendConflictError);
    await backend.deleteContext(owner, id);
    expect((await bucket.getFiles({ prefix: `users/${owner}/contexts/${id}/` }))[0]).toHaveLength(0);
  });
  it("R9: new accounts never send data to a title provider without enabling AI", async () => {
    const settings = new AccountSettings(db); await settings.set(owner, { aiTitlesEnabled: false });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const id = randomUUID(); await store.writeItem(owner, id, { id: randomUUID(), content }, true);
    await new TitleWorker(db, "test-only", undefined, settings).process(store.context(owner, id));
    expect(fetcher).not.toHaveBeenCalled(); expect((await store.getContext(owner, id)).titleState).toBe("fallback");
    expect(await settings.get(other)).toEqual({ aiTitlesEnabled: false }); vi.unstubAllGlobals();
  });
  it("R5: deleting the unfinished first attachment promotes a ready sibling", async () => {
    const id = randomUUID(), first = randomUUID(), next = randomUUID();
    await store.writeItem(owner, id, { id: first, content: { kind: "attachment", name: "cancel.bin", contentType: "application/octet-stream", size: 3 } }, true);
    await store.writeItem(owner, id, { id: next, content }, false);
    await backend.deleteItem(owner, id, first);
    const context = await store.getContext(owner, id); expect(context.firstItemId).toBe(next); expect(context.ready).toBe(true);
    await backend.deleteItem(owner, id, first); expect((await store.getContext(owner, id)).firstItemId).toBe(next);
    await backend.deleteItem(owner, id, next); expect((await store.getContext(owner, id)).ready).toBe(true);
  });
  it("R2: ten active keys is an enforced owner limit", async () => {
    for (const doc of (await db.collection("agentKeys").where("uid", "==", owner).get()).docs) await doc.ref.delete();
    for (let i = 0; i < 10; i++) await store.createKey(owner, `Key ${i}`);
    await expect(store.createKey(owner, "Overflow")).rejects.toMatchObject({ statusCode: 409 });
    for (const key of await store.listKeys(owner)) await store.revokeKey(owner, key.id);
  });
  it("does not overwrite manual titles or revive a deleted context after an AI response", async () => {
    const settings = new AccountSettings(db); await settings.set(owner, { aiTitlesEnabled: true });
    const worker = new TitleWorker(db, "test-only", undefined, settings);
    for (const action of ["rename", "delete"] as const) {
      const id = randomUUID(); await store.writeItem(owner, id, { id: randomUUID(), content }, true);
      let respond!: (value: Response) => void;
      const fetcher = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })); vi.stubGlobal("fetch", fetcher);
      const pending = worker.process(store.context(owner, id));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
      if (action === "rename") await store.rename(owner, id, "My chosen name"); else await backend.deleteContext(owner, id);
      respond(new Response(JSON.stringify({ choices: [{ message: { content: "Model title" } }] })));
      await pending;
      if (action === "rename") expect((await store.getContext(owner, id)).title).toBe("My chosen name");
      else await expect(store.getContext(owner, id)).rejects.toBeInstanceOf(BackendNotFoundError);
    }
    vi.unstubAllGlobals();
  });
});
