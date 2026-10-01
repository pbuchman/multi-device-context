import { readFile } from "node:fs/promises";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const uid = "device-access-owner", radio = "00000000-0000-4000-8000-000000000011", phone = "00000000-0000-4000-8000-000000000012";
const own = "00000000-0000-4000-8000-000000000021", foreign = "00000000-0000-4000-8000-000000000022", item = "00000000-0000-4000-8000-000000000031";
let env: RulesTestEnvironment;
const context = (id: string) => `users/${uid}/contexts/${id}`;
async function seed(path: string, data: Record<string, unknown>) { await env.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), path), data)); }
beforeAll(async () => {
  if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:18080" || process.env.FIREBASE_STORAGE_EMULATOR_HOST !== "127.0.0.1:19199") throw new Error("Dedicated emulators required");
  env = await initializeTestEnvironment({ projectId: "demo-mdc", firestore: { host: "127.0.0.1", port: 18080, rules: await readFile("infra/firestore.rules", "utf8") }, storage: { host: "127.0.0.1", port: 19199, rules: await readFile("infra/storage.rules", "utf8") } });
  await seed(`users/${uid}/devices/${radio}`, { mode: "own", version: 1 });
  await seed(`users/${uid}/devices/${phone}`, { mode: "all", version: 1 });
  for (const [id, origin] of [[own, radio], [foreign, phone]]) await seed(context(id!), { title: "Private", deleting: false, originDeviceId: origin, createdAt: new Date(), updatedAt: new Date() });
  await seed(`${context(own)}/items/${item}`, { content: { kind: "text", text: "Phone reply in radio context" }, device: { id: phone, name: "Phone" }, deleting: false, ready: true, createdAt: new Date() });
});
afterAll(async () => { await env.withSecurityRulesDisabled(async context => { const { deleteDoc } = await import("firebase/firestore"); for (const id of [radio, phone]) await deleteDoc(doc(context.firestore(), `users/${uid}/devices/${id}`)); }); await env.cleanup(); });

describe("installation policy is authoritative", () => {
  it("denies legacy tokens and foreign documents/lists while allowing own contexts including foreign replies", async () => {
    const db = env.authenticatedContext(uid, { mdcDeviceId: radio }).firestore();
    await assertFails(getDoc(doc(env.authenticatedContext(uid).firestore(), context(own))));
    await assertSucceeds(getDoc(doc(db, context(own))));
    await assertSucceeds(getDoc(doc(db, `${context(own)}/items/${item}`)));
    await assertFails(getDoc(doc(db, context(foreign))));
    await assertFails(getDocs(query(collection(db, `users/${uid}/contexts`), where("deleting", "==", false))));
    const result = await assertSucceeds(getDocs(query(collection(db, `users/${uid}/contexts`), where("deleting", "==", false), where("originDeviceId", "==", radio))));
    expect(result.docs.map(d => d.id)).toEqual([own]);
  });
  it("revokes a formerly-full session without token refresh", async () => {
    const db = env.authenticatedContext(uid, { mdcDeviceId: phone }).firestore();
    await assertSucceeds(getDoc(doc(db, context(own))));
    await seed(`users/${uid}/devices/${phone}`, { mode: "own", version: 2 });
    await assertFails(getDoc(doc(db, context(own))));
    await assertSucceeds(getDoc(doc(db, context(foreign))));
    await seed(`users/${uid}/devices/${phone}`, { mode: "all", version: 3 });
  });
  it("binds new context and item authorship to signed installation ID and denies client grant changes", async () => {
    const db = env.authenticatedContext(uid, { mdcDeviceId: radio }).firestore();
    const id = "00000000-0000-4000-8000-000000000024";
    const data = { title: "New", deleting: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), originDeviceId: phone };
    await assertFails(setDoc(doc(db, context(id)), data));
    const batch = writeBatch(db); batch.set(doc(db, context(id)), { ...data, originDeviceId: radio });
    batch.set(doc(db, `${context(id)}/items/${item}`), { content: { kind: "text", text: "Own" }, device: { id: radio, name: "Radio" }, ready: true, deleting: false, createdAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
    await assertFails(setDoc(doc(db, `${context(id)}/items/${foreign}`), { content: { kind: "text", text: "Spoof" }, device: { id: phone, name: "Phone" }, ready: true, deleting: false, createdAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, context(foreign)), { title: "Attack", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, `users/${uid}/devices/${radio}`), { mode: "all" }));
    await assertSucceeds(getDoc(doc(db, `users/${uid}/devices/${radio}`)));
    await assertFails(getDoc(doc(db, `users/${uid}/devices/${phone}`)));
  });
  it("scopes deletion markers without needing the deleted parent", async () => {
    const db = env.authenticatedContext(uid, { mdcDeviceId: radio }).firestore();
    for (const [id, origin] of [[own, radio], [foreign, phone]]) await seed(`users/${uid}/deletedContexts/${id}`, { deleted: true, originDeviceId: origin });
    await assertSucceeds(getDoc(doc(db, `users/${uid}/deletedContexts/${own}`)));
    await assertFails(getDoc(doc(db, `users/${uid}/deletedContexts/${foreign}`)));
    await assertFails(getDocs(collection(db, `users/${uid}/deletedContexts`)));
    await assertSucceeds(getDocs(query(collection(db, `users/${uid}/deletedContexts`), where("originDeviceId", "==", radio))));
  });
  it("denies every direct client Storage path, including full and legacy sessions", async () => {
    for (const claims of [{ mdcDeviceId: radio }, { mdcDeviceId: phone }, {}]) {
      const storage = env.authenticatedContext(uid, claims).storage();
      await assertFails(uploadBytes(ref(storage, `${context(own)}/items/${item}/original`), new Uint8Array([1]), { contentType: "application/octet-stream" }));
      await assertFails(getBytes(ref(storage, `${context(own)}/items/${item}/original`)));
    }
  });
});
