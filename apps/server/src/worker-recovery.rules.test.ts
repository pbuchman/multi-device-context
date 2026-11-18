import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Content } from "@mdc/contracts";
import { FirebaseBackend } from "./firebase.js";
import { AccountSettings } from "./settings.js";
import { TitleWorker } from "./titles.js";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error("Emulators required");
// The worker scans a collection group across accounts. Use a separate emulator project.
const app = initializeApp({ projectId: `demo-mdc-worker-${randomUUID().slice(0, 8)}`, storageBucket: "demo-mdc.appspot.com" }, "worker-recovery");
const db = getFirestore(app);
const backendDependencies = { firestore: db, bucket: getStorage(app).bucket(), auth: getAuth(app) };
const uid = `worker-recovery-${randomUUID()}`;
const owner = db.doc(`users/${uid}`);
const settings = new AccountSettings(db);
const text: Content = { kind: "text", text: "Ready text from a different context" };
const image: Content = { kind: "attachment", name: "Pending image.png", contentType: "image/png", size: 4 };
const pdf: Content = { kind: "attachment", name: "Slow upload.pdf", contentType: "application/pdf", size: 4 };
const itemId = "00000000-0000-4000-8000-000000000099";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.recursiveDelete(owner);
  await backendDependencies.bucket.deleteFiles({ prefix: `${owner.path}/` });
});
afterAll(async () => { await deleteApp(app); });

function seedContext(batch: FirebaseFirestore.WriteBatch, index: number, content: Content, ready: boolean) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const ref = owner.collection("contexts").doc(id);
  const item = ref.collection("items").doc(itemId);
  const createdAt = Timestamp.fromMillis(1000);
  batch.set(ref, { title: "Fallback title", titleState: "pending", deleting: false, ready, firstItemId: itemId, createdAt, updatedAt: createdAt });
  batch.set(item, { deleting: false, ready, content, createdAt });
  return { ref, item };
}

async function titleWorker() {
  await settings.set(uid, { aiTitlesEnabled: true });
  const provider = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "Generated title" } }] })));
  vi.stubGlobal("fetch", provider);
  const worker = new TitleWorker(db, "test-only", undefined, settings, async () => new Uint8Array([137, 80, 78, 71]));
  return { worker, provider };
}

describe("server worker recovery", () => {
  it.each([false, true])("resumes item deletion and repairs the parent after a failed Firestore commit (deleteEmptyContext=%s)", async deleteEmptyContext => {
    const batch = db.batch();
    const { ref, item } = seedContext(batch, 1, pdf, false);
    const sibling = ref.collection("items").doc(randomUUID());
    batch.set(sibling, { deleting: false, ready: true, content: text, createdAt: Timestamp.fromMillis(2000) });
    await batch.commit();
    const original = backendDependencies.bucket.file(`${item.path}/original`);
    await original.save(Buffer.from("test"), { contentType: pdf.contentType });

    const runTransaction = db.runTransaction.bind(db);
    const transactions = vi.spyOn(db, "runTransaction");
    transactions.mockImplementationOnce(runTransaction).mockImplementationOnce((callback, options) => runTransaction(async tx => {
      await callback(tx);
      throw new Error("Synthetic failure before committing item deletion and parent repair");
    }, options));
    const backend = new FirebaseBackend(backendDependencies);
    await expect(backend.deleteItem(uid, ref.id, item.id, undefined, deleteEmptyContext)).rejects.toThrow("Synthetic failure before committing");
    transactions.mockRestore();

    const [queuedItem, unrepaired, marker, [objectExists]] = await Promise.all([
      item.get(), ref.get(), owner.collection("deletedItems").doc(`${ref.id}_${item.id}`).get(), original.exists(),
    ]);
    await new FirebaseBackend(backendDependencies).runCleanupPass();

    expect((await ref.get()).data()).toMatchObject({ firstItemId: sibling.id, ready: true });
    expect(unrepaired.data()).toMatchObject({ firstItemId: item.id, ready: false });
    expect(queuedItem.data()).toMatchObject({ deleting: true });
    expect(marker.get("deleted")).toBe(true);
    expect(objectExists).toBe(false);
    expect((await item.get()).exists).toBe(false);
    expect((await sibling.get()).get("ready")).toBe(true);
  });

  it("titles ready text behind a full page of blocked images and returns to the first page", async () => {
    const batch = db.batch();
    const first = seedContext(batch, 1, image, false);
    for (let index = 2; index <= 25; index++) seedContext(batch, index, image, false);
    const target = seedContext(batch, 26, text, true).ref;
    await batch.commit();

    const { worker, provider } = await titleWorker();
    await worker.pass();
    expect(provider).not.toHaveBeenCalled();
    await worker.pass();
    expect((await target.get()).get("titleState")).toBe("generated");
    expect(provider).toHaveBeenCalledTimes(1);
    const request = JSON.parse(provider.mock.calls[0]![1].body as string);
    expect(request.messages.at(-1).content).toBe(text.text);

    await first.item.update({ ready: true });
    await first.ref.update({ ready: true });
    await worker.pass();
    expect((await first.ref.get()).get("titleState")).toBe("generated");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("preserves title attempts until a slow PDF upload becomes ready", async () => {
    const batch = db.batch();
    const { ref, item } = seedContext(batch, 1, pdf, false);
    await batch.commit();
    const { worker, provider } = await titleWorker();
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (const elapsed of [0, 31_000, 62_000, 93_000]) {
      clock.mockReturnValue(startedAt + elapsed);
      await worker.process(ref);
    }
    clock.mockRestore();

    expect((await ref.get()).get("titleState")).toBe("pending");
    expect((await ref.get()).get("titleAttempts")).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();

    await item.update({ ready: true });
    await ref.update({ ready: true });
    await worker.pass();
    expect((await ref.get()).data()).toMatchObject({ titleState: "generated", titleAttempts: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    const request = JSON.parse(provider.mock.calls[0]![1].body as string);
    expect(request.messages.at(-1).content).toBe(JSON.stringify({ name: pdf.name, type: pdf.contentType }));
  });
});
