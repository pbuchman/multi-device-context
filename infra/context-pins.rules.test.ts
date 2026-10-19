import { readFile } from "node:fs/promises";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { Timestamp, doc, getDoc, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emulatorAddress } from "./emulator-address.js";

const uid = "pin-rules-owner", ownDevice = "00000000-0000-4000-8000-000000000011", allDevice = "00000000-0000-4000-8000-000000000012";
const own = "00000000-0000-4000-8000-000000000021", foreign = "00000000-0000-4000-8000-000000000022", itemId = "00000000-0000-4000-8000-000000000031";
const stamp = Timestamp.fromMillis(1000), path = (id = own) => `users/${uid}/contexts/${id}`;
const record = (originDeviceId = ownDevice) => ({ title: "Saved context", originDeviceId, createdAt: stamp, updatedAt: stamp, deleting: false });
let env: RulesTestEnvironment;
const client = (device = ownDevice, owner = uid) => env.authenticatedContext(owner, { mdcDeviceId: device }).firestore();
async function seed(path: string, data: Record<string, unknown>) { await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), path), data)); }
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: "demo-mdc", firestore: { ...emulatorAddress(process.env.FIRESTORE_EMULATOR_HOST), rules: await readFile("infra/firestore.rules", "utf8") } }); });
beforeEach(async () => {
  await env.clearFirestore();
  await seed(`users/${uid}/devices/${ownDevice}`, { mode: "own", version: 1 });
  await seed(`users/${uid}/devices/${allDevice}`, { mode: "all", version: 1 });
  await seed(path(), record()); await seed(path(foreign), record(allDevice));
});
afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });

describe("saved context pin policy", () => {
  it("pins legacy documents at server time and unpins with null without changing activity", async () => {
    const ref = doc(client(), path());
    await assertSucceeds(updateDoc(ref, { pinnedAt: serverTimestamp() }));
    const pinned = (await getDoc(ref)).data()!;
    expect(pinned.pinnedAt).toBeInstanceOf(Timestamp); expect(pinned.updatedAt).toEqual(stamp);
    await assertFails(updateDoc(ref, { pinnedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(ref, { pinnedAt: null }));
    expect((await getDoc(ref)).data()).toMatchObject({ pinnedAt: null, updatedAt: stamp });
    await assertSucceeds(updateDoc(ref, { pinnedAt: null }));
  });
  it("uses current own/all policy and denies foreign owners, legacy sessions and deleting/missing parents", async () => {
    await assertFails(updateDoc(doc(client(), path(foreign)), { pinnedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(client(allDevice), path()), { pinnedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(client(allDevice, "other-owner"), path()), { pinnedAt: null }));
    await assertFails(updateDoc(doc(env.authenticatedContext(uid).firestore(), path()), { pinnedAt: null }));
    await seed(`users/${uid}/devices/${allDevice}`, { mode: "own", version: 2 });
    await assertFails(updateDoc(doc(client(allDevice), path()), { pinnedAt: null }));
    await seed(path(), { ...record(), deleting: true });
    await assertFails(updateDoc(doc(client(), path()), { pinnedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(client(), path(itemId)), { pinnedAt: serverTimestamp() }));
  });
  it("rejects client stamps, combined edits and unknown fields but accepts absent/null pin metadata on creation", async () => {
    const db = client(), ref = doc(db, path());
    for (const update of [{ pinnedAt: stamp }, { pinnedAt: 1000 }, { pinnedAt: true }, { pinnedAt: serverTimestamp(), updatedAt: serverTimestamp() }, { pinnedAt: serverTimestamp(), title: "Altered" }, { pinnedAt: serverTimestamp(), extra: true }]) {
      await assertFails(updateDoc(ref, update));
    }
    await assertFails(setDoc(doc(db, path(itemId)), { ...record(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), pinnedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(db, path(itemId)), { ...record(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), pinnedAt: null }));
  });
  it("preserves pins when older clients rename or append using existing metadata writes", async () => {
    const db = client(), ref = doc(db, path());
    await assertSucceeds(updateDoc(ref, { pinnedAt: serverTimestamp() })); const pin = (await getDoc(ref)).data()!.pinnedAt;
    await assertSucceeds(updateDoc(ref, { title: "Manual title", titleState: "manual", updatedAt: serverTimestamp() }));
    const batch = writeBatch(db);
    batch.update(ref, { updatedAt: serverTimestamp() });
    batch.set(doc(db, `${path()}/items/${itemId}`), { content: { kind: "text", text: "Appended by an older client" }, device: { id: ownDevice, name: "Phone" }, createdAt: serverTimestamp(), ready: true, deleting: false });
    await assertSucceeds(batch.commit()); expect((await getDoc(ref)).data()!.pinnedAt).toEqual(pin);
  });
});
