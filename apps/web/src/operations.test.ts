import { beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ContextOperations } from "./operations.js";
import { DurableOutbox } from "./outbox.js";
import { openLocalDatabase, result } from "./local-db.js";
const contextId = "00000000-0000-4000-8000-000000000001", itemId = "00000000-0000-4000-8000-000000000002", nextId = "00000000-0000-4000-8000-000000000003";
const draft = { contextId, itemId, title: "Synthetic", content: { kind: "attachment" as const, name: "secret.bin", size: 3, contentType: "application/octet-stream" }, bytes: new Uint8Array([1,2,3]), device: { id: contextId, name: "Test" }, createsContext: true };
function cloud() { return { deletionMarkers: vi.fn(async () => ({ contexts: [] as string[], items: [] as { contextId: string; itemId: string }[] })), publish: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}) }; }
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
it("R4: persists ID-only deletion across a failed request and process restart; retry actually deletes", async () => {
  const outbox = new DurableOutbox({ projectId: "test", uid: "owner" }), remote = cloud();
  await outbox.enqueue(draft);
  remote.deleteContext.mockRejectedValueOnce(new TypeError("offline"));
  const first = new ContextOperations(outbox, remote);
  expect(await first.remove(contextId)).toBe(false); first.runner.stop();
  expect(await outbox.list()).toEqual([]);
  const db = await openLocalDatabase(); const rows = await result(db.transaction("records").objectStore("records").getAll()); db.close();
  expect(JSON.stringify(rows)).not.toContain("secret.bin"); expect(JSON.stringify(rows)).not.toContain('"bytes"');
  outbox.close(); const reopened = new DurableOutbox({ projectId: "test", uid: "owner" });
  const second = new ContextOperations(reopened, remote); await reopened.retry(); await second.runner.drain(); second.runner.stop();
  expect(remote.deleteContext).toHaveBeenCalledTimes(2); expect(await reopened.deletions()).toEqual([]); reopened.close();
});
it("R5: deleting a first queued item preserves and promotes its successor", async () => {
  const outbox = new DurableOutbox({ projectId: "test", uid: "owner" }), remote = cloud();
  await outbox.enqueue(draft); await outbox.enqueue({ ...draft, itemId: nextId, createsContext: false });
  const operations = new ContextOperations(outbox, remote); await operations.remove(contextId, itemId); operations.runner.stop();
  expect(remote.deleteItem).toHaveBeenCalledWith(contextId, itemId);
  expect(remote.publish).toHaveBeenCalledTimes(1); expect(remote.publish).toHaveBeenCalledWith(expect.objectContaining({ itemId: nextId, createsContext: true }));
  await expect(outbox.enqueue(draft)).rejects.toThrow("deleted"); outbox.close();
});
it("R1/R5: reconcile remote deletion before replaying queued bytes", async () => {
  const outbox = new DurableOutbox({ projectId: "test", uid: "owner" }), remote = cloud(); await outbox.enqueue(draft);
  remote.deletionMarkers.mockResolvedValue({ contexts: [], items: [{ contextId, itemId }] });
  const operations = new ContextOperations(outbox, remote); await operations.runner.drain(); operations.runner.stop();
  expect(remote.publish).not.toHaveBeenCalled(); expect(await outbox.list()).toEqual([]); outbox.close();
});
it("records a failed preparation as a retryable deletion failure before HTTP attempts", async () => {
  const outbox = new DurableOutbox({ projectId: "test", uid: "preparation" }), remote = cloud();
  remote.deletionMarkers.mockRejectedValueOnce(new TypeError("offline"));
  const operations = new ContextOperations(outbox, remote);
  expect(await operations.remove(contextId)).toBe(false); operations.runner.stop();
  expect(await outbox.deletions()).toEqual([expect.objectContaining({ attempts: 1, paused: false })]);
  expect(remote.deleteContext).not.toHaveBeenCalled(); outbox.close();
});
it("keeps a newly queued deletion pending while another drain is running without Web Locks", async () => {
  const outbox = new DurableOutbox({ projectId: "test", uid: "overlap" }), remote = cloud();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  remote.deletionMarkers.mockImplementationOnce(async () => { await gate; return { contexts: [], items: [] }; });
  const operations = new ContextOperations(outbox, remote); const first = operations.runner.drain();
  await Promise.resolve();
  expect(await operations.remove(contextId, itemId)).toBe(false);
  expect(await outbox.deletions()).toEqual([expect.objectContaining({ attempts: 0, paused: false })]);
  release(); await first; operations.runner.stop();
  expect(remote.deleteItem).toHaveBeenCalledTimes(1); expect(await outbox.deletions()).toEqual([]); outbox.close();
});
