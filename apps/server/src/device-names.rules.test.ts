import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeviceAccessStore } from "./device-access.js";
import { AgentStore } from "./agent-store.js";
import { FirestoreAccessAdministration } from "./access.js";
import { emulatorAddress } from "../../../infra/emulator-address.js";

emulatorAddress(process.env.FIRESTORE_EMULATOR_HOST);
const app = initializeApp({ projectId: "demo-mdc" }, "device-names-integration");
const db = getFirestore(app);
const owner = "device-names-integration-owner", other = "device-names-integration-other";
const devices = new DeviceAccessStore(db, {} as never);
const agents = new AgentStore(db, {} as never, {} as never);
const cleanup = async () => { for (const uid of [owner, other]) await db.recursiveDelete(db.doc(`users/${uid}`)); };
const credentialIds: string[] = [];
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await Promise.all(credentialIds.map(id => db.doc(`internalDeviceCredentials/${id}`).delete()));
  await deleteApp(app);
});
async function context(id: string, originDeviceId: string | undefined, createdAt: Timestamp, updatedAt = createdAt, deleting = false) {
  const ref = agents.context(owner, id);
  await ref.set({ title: "Synthetic origin", ...(originDeviceId ? { originDeviceId } : {}), createdAt, updatedAt, deleting });
  return ref;
}

describe("device naming persistence", () => {
  it("persists an own-device alias across exchange without changing policy, credentials or history", async () => {
    const enrolled = await devices.enroll(owner, { name: "Default phone", platform: "android" });
    credentialIds.push(enrolled.device.id);
    const ref = db.doc(`users/${owner}/devices/${enrolled.device.id}`);
    const before = (await ref.get()).data()!;
    const credentialRef = db.doc(`internalDeviceCredentials/${enrolled.device.id}`), credential = (await credentialRef.get()).data();
    const parent = await context(randomUUID(), enrolled.device.id, Timestamp.fromMillis(1));
    const item = parent.collection("items").doc(randomUUID());
    await item.set({ device: { id: enrolled.device.id, name: "Default phone" }, deleting: false, createdAt: Timestamp.fromMillis(1), content: { kind: "text", text: "Immutable history" } });
    const history = (await item.get()).data();
    const renamed = await devices.rename({ uid: owner, deviceId: enrolled.device.id }, { name: "  Łódź Radio  " });
    expect(renamed).toMatchObject({ name: "Łódź Radio", mode: "own", version: 1, createdAt: enrolled.device.createdAt });
    expect((await ref.get()).data()).toEqual({ ...before, name: "Łódź Radio", updatedAt: expect.any(Timestamp) });
    expect((await credentialRef.get()).data()).toEqual(credential);
    expect((await item.get()).data()).toEqual(history);
    expect(await devices.exchange(owner, enrolled.device.id, enrolled.credential)).toEqual(renamed);
    await expect(devices.rename({ uid: other, deviceId: enrolled.device.id }, { name: "Stolen" })).rejects.toMatchObject({ statusCode: 401 });
    expect((await agents.listDevices(owner)).records).toContainEqual({ id: enrolled.device.id, name: "Łódź Radio" });
    expect((await agents.listDevices(other)).records).toEqual([]);
  });
  it("uses the passkey-bound alias action while preserving a concurrently changed policy", async () => {
    const enrolled = await devices.enroll(owner, { name: "Mac", platform: "desktop" });
    credentialIds.push(enrolled.device.id);
    await db.doc(`users/${owner}/accessSecurity/passkey`).set({ id: "synthetic-passkey", publicKey: Buffer.from([1, 2, 3]).toString("base64url"), counter: 0, revision: randomUUID(), userId: "synthetic" });
    const service = new FirestoreAccessAdministration(db, { origin: "https://app.example.test", webauthn: {
      generateAuthenticationOptions: async () => ({ challenge: "synthetic-challenge" }),
      verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
    } as never });
    const challenge = await service.challenge(owner, { action: "rename-device", targetId: enrolled.device.id, name: "  MacBook  " });
    await db.doc(`users/${owner}/devices/${enrolled.device.id}`).update({ mode: "all", version: 8 });
    const result = await service.complete(owner, challenge.challengeId, {} as never);
    expect(result).toMatchObject({ kind: "device", device: { name: "MacBook", mode: "all", version: 8 } });
    await expect(service.complete(owner, challenge.challengeId, {} as never)).rejects.toMatchObject({ statusCode: 410 });
    const foreign = randomUUID();
    await db.doc(`users/${other}/devices/${foreign}`).set({ ...enrolled.device, name: "Other" });
    await expect(service.challenge(owner, { action: "rename-device", targetId: foreign, name: "Stolen" })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("device origin queries against Firestore", () => {
  it("filters before limit and paginates equal timestamps deterministically in both directions", async () => {
    const origin = randomUUID(), another = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const created = new Timestamp(100, 123456789);
    for (const id of ids) await context(id, origin, created);
    await context(randomUUID(), another, new Timestamp(101, 0));
    await context(randomUUID(), origin, new Timestamp(102, 0), undefined, true);
    for (const order of ["asc", "desc"] as const) {
      const found: string[] = []; let after: string | undefined;
      for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
        const page = await agents.listContexts(owner, after, 1, { deviceId: origin, order });
        found.push(...page.records.map(record => record.id)); after = page.cursor!;
      }
      expect(found).toEqual(order === "asc" ? ids : [...ids].reverse());
    }
    const old = randomUUID(), recent = randomUUID();
    await context(old, origin, new Timestamp(200, 0), new Timestamp(1000, 0));
    const newest = await context(recent, origin, new Timestamp(300, 0));
    await newest.collection("items").doc(randomUUID()).set({ device: { id: another, name: "Later sender" }, createdAt: new Timestamp(1001, 0), deleting: false });
    expect((await agents.listContexts(owner, undefined, 1, { deviceId: origin, order: "desc" })).records[0]?.id).toBe(recent);
    expect((await agents.listContexts(other, undefined, 1, { deviceId: origin, order: "desc" })).records).toEqual([]);
  });
  it("discovers immutable legacy origins without using a promoted sender or deleted snapshot", async () => {
    const original = randomUUID(), sender = randomUUID(), missing = randomUUID(), deleted = randomUUID();
    const parent = await context(randomUUID(), original, new Timestamp(500, 0));
    const firstItemId = randomUUID(), originalItemId = randomUUID();
    await parent.update({ firstItemId });
    await parent.collection("items").doc(firstItemId).set({ device: { id: sender, name: "Wrong promoted sender" }, createdAt: new Timestamp(2, 0), deleting: false });
    await parent.collection("items").doc(originalItemId).set({ device: { id: original, name: "Legacy MacBook" }, createdAt: new Timestamp(1, 0), deleting: false });
    const gone = await context(randomUUID(), missing, new Timestamp(501, 0));
    const goneId = randomUUID(); await gone.update({ firstItemId: goneId });
    await gone.collection("items").doc(goneId).set({ device: { id: missing, name: "Deleted name" }, createdAt: new Timestamp(1, 0), deleting: true });
    const deletedParent = await context(randomUUID(), deleted, new Timestamp(502, 0), undefined, true);
    await deletedParent.collection("items").doc(randomUUID()).set({ device: { id: deleted, name: "Deleted context" }, createdAt: new Timestamp(1, 0), deleting: false });
    const before = (await parent.collection("items").get()).docs.map(doc => doc.data());
    const records = (await agents.listDevices(owner)).records;
    expect(records).toContainEqual({ id: original, name: "Legacy MacBook" });
    expect(records).toContainEqual({ id: missing, name: missing });
    expect(records.some(record => record.id === sender || record.id === deleted)).toBe(false);
    expect(JSON.stringify(records)).not.toContain("Deleted name");
    expect((await parent.collection("items").get()).docs.map(doc => doc.data())).toEqual(before);
  });
});
