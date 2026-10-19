import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { ContextOriginsStore } from "./context-origins.js";
import { DeviceAccessStore, deviceIdentity } from "./device-access.js";
import { emulatorAddress } from "../../../infra/emulator-address.js";

emulatorAddress(process.env.FIRESTORE_EMULATOR_HOST);
const app = initializeApp({ projectId: "demo-mdc" }, "context-origins-integration");
const db = getFirestore(app);
const store = new ContextOriginsStore(db);
const owners = new Set<string>();
const timestamp = Timestamp.fromMillis(1);
afterAll(async () => {
  for (const uid of owners) {
    await db.recursiveDelete(db.doc(`users/${uid}`));
    await db.recursiveDelete(db.doc(`internalContextOriginAccounts/${uid}`));
  }
  await deleteApp(app);
});

function owner() { const uid = `origins-${randomUUID()}`; owners.add(uid); return uid; }
async function device(uid: string, mode: "own" | "all" = "all", name = "Registered source") {
  const id = randomUUID();
  const data = { name, platform: "browser", mode, version: 1, createdAt: timestamp, updatedAt: timestamp };
  await db.doc(`users/${uid}/devices/${id}`).set(data);
  return { uid, deviceId: id };
}
async function context(uid: string, originDeviceId?: string, extra: Record<string, unknown> = {}) {
  const ref = db.doc(`users/${uid}/contexts/${randomUUID()}`);
  await ref.set({ title: "Synthetic context", deleting: false, createdAt: timestamp, updatedAt: timestamp, ...(originDeviceId ? { originDeviceId } : {}), ...extra });
  return ref;
}
async function item(parent: FirebaseFirestore.DocumentReference, id: string, name: string, extra: Record<string, unknown> = {}) {
  const ref = parent.collection("items").doc(randomUUID());
  await ref.set({ content: { kind: "text", text: "Immutable history" }, device: { id, name }, deleting: false, ready: true, createdAt: timestamp, ...extra });
  return ref;
}
const palette = (uid: string) => db.doc(`internalContextOriginAccounts/${uid}`);

describe("bounded context origins against Firestore", () => {
  it("silently omits foreign, missing, deleted, inaccessible, and pre-origin contexts", async () => {
    const uid = owner(), other = owner();
    const own = await device(uid, "own", "Radio"), full = await device(uid), foreign = await device(other);
    const visible = await context(uid, own.deviceId), inaccessible = await context(uid, full.deviceId);
    const deleted = await context(uid, own.deviceId, { deleting: true }), legacy = await context(uid);
    const foreignContext = await context(other, foreign.deviceId);
    const ids = [visible.id, visible.id, inaccessible.id, deleted.id, legacy.id, foreignContext.id, randomUUID()];
    expect((await store.get(own, ids)).records).toEqual([{ id: own.deviceId, name: "Radio", colorIndex: 0 }]);
    expect((await palette(uid).collection("origins").get()).docs.map(doc => doc.id)).toEqual([own.deviceId]);
    expect((await store.get(full, ids)).records.map(record => record.id).sort()).toEqual([own.deviceId, full.deviceId].sort());
    expect((await store.get(foreign, ids)).records).toEqual([{ id: foreign.deviceId, name: "Registered source", colorIndex: 0 }]);
    expect((await palette(other).collection("origins").get()).size).toBe(1);
  });

  it("rechecks live policy after authentication and rejects removed installations even for empty batches", async () => {
    const uid = owner();
    const installation = await device(uid), another = randomUUID();
    const own = await context(uid, installation.deviceId), external = await context(uid, another);
    const access = new DeviceAccessStore(db, { verifyIdToken: async () => ({ uid, mdcDeviceId: installation.deviceId }) } as never);
    const authenticated = await access.authenticate("synthetic-firebase-token");
    expect(authenticated.device.mode).toBe("all");
    await db.doc(`users/${uid}/devices/${installation.deviceId}`).update({ mode: "own", version: 2 });
    expect((await store.get(deviceIdentity(authenticated), [own.id, external.id])).records.map(record => record.id)).toEqual([installation.deviceId]);
    expect((await palette(uid).collection("origins").doc(another).get()).exists).toBe(false);
    await db.doc(`users/${uid}/devices/${installation.deviceId}`).delete();
    for (const ids of [[], [own.id, external.id]]) {
      await expect(store.get(deviceIdentity(authenticated), ids)).rejects.toMatchObject({ statusCode: 401 });
    }
  });

  it("resolves names from registered origins or matching legacy snapshots, never a later sender", async () => {
    const uid = owner(), installation = await device(uid);
    const registered = await device(uid, "own", "Current Mac alias"), original = randomUUID(), sender = randomUUID(), unknown = randomUUID();
    const virtualAgent = "00000000-0000-4000-8000-000000000002";
    const current = await context(uid, registered.deviceId), legacy = await context(uid, original), absent = await context(uid, unknown);
    const virtual = await context(uid, virtualAgent), preOrigin = await context(uid);
    const oldName = await item(current, registered.deviceId, "Old alias");
    await current.update({ firstItemId: oldName.id });
    const promoted = await item(legacy, sender, "Wrong promoted sender");
    await legacy.update({ firstItemId: promoted.id });
    const matching = await item(legacy, original, "Legacy laptop");
    const deleted = await item(absent, unknown, "Deleted name", { deleting: true });
    await absent.update({ firstItemId: deleted.id });
    await item(absent, sender, "Wrong surviving sender");
    const virtualItem = await item(virtual, virtualAgent, "Agent");
    await virtual.update({ firstItemId: virtualItem.id });
    await item(preOrigin, sender, "Cannot infer origin");
    const before = (await matching.get()).data();
    const records = (await store.get(installation, [current.id, legacy.id, absent.id, virtual.id, preOrigin.id])).records;
    expect(records).toEqual(expect.arrayContaining([
      { id: registered.deviceId, name: "Current Mac alias", colorIndex: expect.any(Number) },
      { id: original, name: "Legacy laptop", colorIndex: expect.any(Number) },
      { id: unknown, name: "Unknown device", colorIndex: expect.any(Number) },
      { id: virtualAgent, name: "Agent", colorIndex: expect.any(Number) },
    ]));
    expect(records).toHaveLength(4);
    expect(JSON.stringify(records)).not.toMatch(/Wrong|Deleted name|Cannot infer/);
    expect((await matching.get()).data()).toEqual(before);
  });

  it("preserves the assigned color through rename, source deletion, and context deletion", async () => {
    const uid = owner(), installation = await device(uid, "all", "Mac"), origin = await device(uid, "own", "Phone");
    const parent = await context(uid, origin.deviceId), first = await item(parent, origin.deviceId, "Historical phone");
    await parent.update({ firstItemId: first.id });
    const history = (await first.get()).data(), contextBefore = (await parent.get()).data();
    const initial = (await store.get(installation, [parent.id])).records[0]!;
    await new DeviceAccessStore(db, {} as never).rename(origin, { name: "Radio" });
    expect((await store.get(installation, [parent.id])).records).toEqual([{ ...initial, name: "Radio" }]);
    expect((await db.doc(`users/${uid}/devices/${origin.deviceId}`).get()).data()).not.toHaveProperty("colorIndex");
    expect((await parent.get()).data()).toEqual(contextBefore);
    expect((await first.get()).data()).toEqual(history);
    await db.doc(`users/${uid}/devices/${origin.deviceId}`).delete();
    expect((await store.get(installation, [parent.id])).records).toEqual([{ ...initial, name: "Historical phone" }]);
    await parent.update({ deleting: true });
    expect((await store.get(installation, [parent.id])).records).toEqual([]);
    expect((await palette(uid).collection("origins").doc(origin.deviceId).get()).data()).toEqual({ colorIndex: initial.colorIndex });
    const replacement = await context(uid, origin.deviceId);
    expect((await store.get(installation, [replacement.id])).records).toEqual([{ ...initial, name: "Unknown device" }]);
  });

  it("projects only source metadata when legacy first or surviving items contain large content", async () => {
    const uid = owner(), installation = await device(uid), firstOrigin = randomUUID(), survivingOrigin = randomUUID();
    const first = await context(uid, firstOrigin), surviving = await context(uid, survivingOrigin);
    const largeContent = { kind: "text", text: "a".repeat(262_144) };
    const direct = await item(first, firstOrigin, "Direct legacy", { content: largeContent });
    await first.update({ firstItemId: direct.id });
    const promoted = await item(surviving, installation.deviceId, "Different sender", { content: largeContent });
    await surviving.update({ firstItemId: promoted.id });
    await item(surviving, survivingOrigin, "Surviving legacy", { content: largeContent });
    const itemReads: Record<string, unknown>[] = [];
    // Observe actual emulator result documents to ensure projections work for both
    // point reads and indexed fallback queries, without mocking Firestore behavior.
    const observed = new Proxy(db, { get(target, property) {
      if (property === "runTransaction") return (operation: (tx: Transaction) => Promise<unknown>) => target.runTransaction(tx => operation(new Proxy(tx, { get(transaction, method) {
        const value = Reflect.get(transaction, method, transaction);
        if (method !== "get" && method !== "getAll") return typeof value === "function" ? value.bind(transaction) : value;
        return async (...args: unknown[]) => {
          const result = await value.apply(transaction, args);
          const snapshots: DocumentSnapshot[] = Array.isArray(result) ? result : result.docs ?? [result];
          for (const snapshot of snapshots) if (snapshot.ref.parent.id === "items" && snapshot.exists) itemReads.push(snapshot.data()!);
          return result;
        };
      } })));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const records = (await new ContextOriginsStore(observed).get(installation, [first.id, surviving.id])).records;
    expect(records.map(record => record.name).sort()).toEqual(["Direct legacy", "Surviving legacy"]);
    expect(itemReads).toHaveLength(3);
    for (const read of itemReads) expect(Object.keys(read).sort()).toEqual(["deleting", "device"]);
  });

  it("allocates the first eight distinctly, reuses the least-used index, and never recolors or recounts existing IDs", async () => {
    const uid = owner(), installation = await device(uid);
    const contexts = [];
    for (let index = 0; index < 17; index++) contexts.push(await context(uid, randomUUID()));
    const first = (await store.get(installation, contexts.slice(0, 8).map(parent => parent.id))).records;
    expect(first.map(record => record.colorIndex).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const next = (await store.get(installation, contexts.slice(8).map(parent => parent.id))).records;
    expect(next.map(record => record.colorIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);
    const repeated = (await store.get(installation, contexts.map(parent => parent.id).reverse())).records;
    for (const record of [...first, ...next]) expect(repeated).toContainEqual(record);
    expect((await palette(uid).get()).data()).toEqual({ counts: [3, 2, 2, 2, 2, 2, 2, 2] });
    expect((await palette(uid).collection("origins").get()).size).toBe(17);
  });

  it("serializes simultaneous allocations for distinct and repeated origins", async () => {
    const uid = owner(), installation = await device(uid);
    const contexts = await Promise.all(Array.from({ length: 4 }, () => context(uid, randomUUID())));
    const results = await Promise.all([...contexts, contexts[0]!, contexts[0]!].map(parent => store.get(installation, [parent.id])));
    const records = results.map(result => result.records[0]!);
    expect(new Set(records.slice(0, 4).map(record => record.colorIndex)).size).toBe(4);
    expect(records[4]).toEqual(records[0]); expect(records[5]).toEqual(records[0]);
    expect((await palette(uid).get()).data()).toEqual({ counts: [1, 1, 1, 1, 0, 0, 0, 0] });
    expect((await palette(uid).collection("origins").get()).size).toBe(4);
  });
});
