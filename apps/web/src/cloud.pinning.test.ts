import { beforeEach, expect, it, vi } from "vitest";
import type { FirebaseApp } from "firebase/app";
import type { Id } from "@mdc/contracts";
import { FirebaseCloud } from "./cloud.js";
const f = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), transaction: vi.fn(), listen: vi.fn(), reads: vi.fn(),
}));
vi.mock("firebase/firestore", async importOriginal => ({
  ...await importOriginal<typeof import("firebase/firestore")>(),
  initializeFirestore: () => ({}), memoryLocalCache: () => ({}), collection: (_db: unknown, path: string) => ({ path }),
  doc: (_db: unknown, path: string) => ({ path }), query: (reference: unknown) => reference,
  runTransaction: f.transaction, onSnapshot: f.listen, getDocsFromServer: f.reads,
  serverTimestamp: () => "SERVER_TIMESTAMP", disableNetwork: async () => {}, enableNetwork: async () => {},
}));
const id = "00000000-0000-4000-8000-000000000001" as Id;
const device = { id: "00000000-0000-4000-8000-000000000002", name: "Laptop", platform: "browser" as const, mode: "all" as const, version: 1, createdAt: 1, updatedAt: 1 };
const cloud = (mode: "own" | "all" = "all") => new FirebaseCloud({} as FirebaseApp, "user", async () => "unused", { ...device, mode });
const timestamp = (millis: number) => ({ toMillis: () => millis });
const document = (pinnedAt?: unknown, pending = false) => ({ id, data: () => ({ title: "Chat", createdAt: timestamp(1), updatedAt: timestamp(2), deleting: false, pinnedAt }), metadata: { fromCache: false, hasPendingWrites: pending } });
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals();
  f.get.mockResolvedValue({ exists: () => true, data: () => ({ deleting: false, originDeviceId: device.id }) });
  f.transaction.mockImplementation(async (_db, body) => body({ get: f.get, update: f.update }));
});
it("pins with a server timestamp and changes only pinnedAt, preserving updatedAt and unread semantics", async () => {
  await cloud().setContextPinned(id, true);
  expect(f.transaction).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledWith({ path: `users/user/contexts/${id}` });
  expect(f.update).toHaveBeenCalledWith({ path: `users/user/contexts/${id}` }, { pinnedAt: "SERVER_TIMESTAMP" });
});
it("preserves the original timestamp on repeated pin and makes repeated unpin a no-op", async () => {
  f.get.mockResolvedValueOnce({ exists: () => true, data: () => ({ deleting: false, pinnedAt: timestamp(50) }) });
  await cloud().setContextPinned(id, true);
  await cloud().setContextPinned(id, false);
  expect(f.update).not.toHaveBeenCalled();
  f.get.mockResolvedValueOnce({ exists: () => true, data: () => ({ deleting: false, pinnedAt: timestamp(50) }) });
  await cloud().setContextPinned(id, false);
  expect(f.update).toHaveBeenCalledWith(expect.anything(), { pinnedAt: null });
});
it("uses an explicit target state on transaction retry instead of toggling", async () => {
  f.transaction.mockImplementationOnce(async (_db, body) => {
    await body({ get: f.get, update: f.update });
    f.get.mockResolvedValueOnce({ exists: () => true, data: () => ({ deleting: false, pinnedAt: timestamp(55) }) });
    await body({ get: f.get, update: f.update });
  });
  await cloud().setContextPinned(id, true);
  expect(f.update).toHaveBeenCalledTimes(1);
  expect(f.update.mock.calls[0]![1]).toEqual({ pinnedAt: "SERVER_TIMESTAMP" });
});
it("rejects missing, deleting, own-mode-inaccessible and invalidated contexts", async () => {
  for (const snapshot of [
    { exists: () => false, data: () => ({}) },
    { exists: () => true, data: () => ({ deleting: true }) },
    { exists: () => true, data: () => ({ deleting: false, originDeviceId: "another-device" }) },
  ]) {
    f.get.mockResolvedValueOnce(snapshot);
    await expect(cloud("own").setContextPinned(id, true)).rejects.toThrow(/unavailable/);
  }
  const instance = cloud();
  instance.invalidate();
  await expect(instance.setContextPinned(id, true)).rejects.toThrow(/access changed/);
  expect(f.update).not.toHaveBeenCalled();
});
it("does not start or queue offline transactions and allows retry after an online error", async () => {
  const instance = cloud();
  await instance.setNetworkEnabled(false);
  await expect(instance.setContextPinned(id, true)).rejects.toThrow(/Go online/);
  expect(f.transaction).not.toHaveBeenCalled();
  await instance.setNetworkEnabled(true);
  f.transaction.mockRejectedValueOnce(new Error("Connection lost"));
  await expect(instance.setContextPinned(id, true)).rejects.toThrow("Connection lost");
  await instance.setContextPinned(id, true);
  expect(f.update).toHaveBeenCalledOnce();
  vi.stubGlobal("navigator", { onLine: false });
  await expect(cloud().setContextPinned(id, true)).rejects.toThrow(/Go online/);
  expect(f.transaction).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});
it("normalizes absent/null pins and timestamps without assigning fallback pin times", async () => {
  f.reads.mockResolvedValue({ docs: [document(), { ...document(null), id: "null" }, { ...document(timestamp(30)), id: "pinned" }, { ...document("invalid"), id: "invalid" }], metadata: { hasPendingWrites: false } });
  const snapshot = await cloud().refreshContexts();
  expect(snapshot.records.map(record => [record.id, record.pinnedAt])).toEqual([[id, null], ["invalid", null], ["null", null], ["pinned", 30]]);
});
it("keeps acknowledged pin state through local writes and publishes the new state only with a settled snapshot", () => {
  let listener!: (snapshot: unknown) => void;
  f.listen.mockImplementation((_query, _options, callback) => { listener = callback; return () => {}; });
  const emitted: import("./cloud.js").CloudSnapshot<import("./model.js").ContextRecord>[] = [];
  cloud().subscribeContexts(snapshot => emitted.push(snapshot), cause => { throw cause; });
  const emit = (pin: unknown, pending: boolean) => listener({ docs: [document(pin, pending)], metadata: { fromCache: false, hasPendingWrites: pending } });
  emit(null, false); emit(null, true); emit(timestamp(20), false); emit(null, true); emit(null, false);
  expect(emitted.map(snapshot => snapshot.records[0]!.pinnedAt)).toEqual([null, null, 20, 20, null]);
  expect(emitted.map(snapshot => snapshot.records[0]!.updatedAt)).toEqual([2, 2, 2, 2, 2]);
});

it("preserves an existing timestamp in the first pending append/rename snapshot and across listener restarts", () => {
  let listener!: (snapshot: unknown) => void;
  f.listen.mockImplementation((_query, _options, callback) => { listener = callback; return () => {}; });
  const instance = cloud(); const pins: (number | null | undefined)[] = [];
  const subscribe = () => instance.subscribeContexts(snapshot => pins.push(snapshot.records[0]!.pinnedAt), cause => { throw cause; });
  const emit = (pin: unknown, pending: boolean) => listener({ docs: [document(pin, pending)], metadata: { fromCache: false, hasPendingWrites: pending } });
  const stop = subscribe();
  emit(timestamp(20), true); // First listener snapshot: unrelated queued append.
  stop(); const stopAgain = subscribe();
  emit(timestamp(20), true); // Android listener resumes while rename is pending.
  emit(null, true); // Explicit unpin is still awaiting acknowledgment.
  emit(null, false);
  emit(null, true); // New serverTimestamp pin has no resolved value before ack.
  emit(timestamp(30), false);
  expect(pins).toEqual([20, 20, 20, null, null, 30]);
  stopAgain();
});
it("shares acknowledged pin state between server refreshes and listener restarts despite pending local writes", async () => {
  const instance = cloud();
  const refresh = async (pin: unknown, pending: boolean) => {
    f.reads.mockResolvedValueOnce({ docs: [document(pin, pending)], metadata: { hasPendingWrites: pending } });
    return (await instance.refreshContexts()).records[0]!.pinnedAt;
  };
  expect(await refresh(timestamp(20), true)).toBe(20);
  expect(await refresh(null, true)).toBe(20);
  let listener!: (snapshot: unknown) => void;
  f.listen.mockImplementation((_query, _options, callback) => { listener = callback; return () => {}; });
  const pins: (number | null | undefined)[] = [];
  instance.subscribeContexts(snapshot => pins.push(snapshot.records[0]!.pinnedAt), cause => { throw cause; });
  listener({ docs: [document(null, true)], metadata: { fromCache: false, hasPendingWrites: true } });
  expect(pins).toEqual([20]);
  expect(await refresh(null, false)).toBeNull();
  expect(await refresh(null, true)).toBeNull();
  expect(await refresh(timestamp(30), false)).toBe(30);
});

it("loads context origins through authenticated API with strict request and response contracts", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ records: [{ id: device.id, name: "Current device name", colorIndex: 7 }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const instance = cloud();
  await expect(instance.getContextOrigins([id])).resolves.toEqual([{ id: device.id, name: "Current device name", colorIndex: 7 }]);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/context-origins"), {
    method: "POST", headers: { authorization: "Bearer unused", "content-type": "application/json" }, body: JSON.stringify({ contextIds: [id] }),
  });
  await expect(instance.getContextOrigins(Array.from({ length: 101 }, () => id))).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ records: [{ id: device.id, name: "Invalid index", colorIndex: 8 }] })));
  await expect(instance.getContextOrigins([id])).rejects.toThrow();
  instance.invalidate();
  await expect(instance.getContextOrigins([id])).rejects.toThrow(/access changed/);
  vi.unstubAllGlobals();
});
