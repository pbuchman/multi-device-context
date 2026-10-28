import { beforeEach, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DurableOutbox, PublishFailure } from "./outbox.js";
import { applyLocalAccess } from "./local-access.js";
import { done, openLocalDatabase, result } from "./local-db.js";
const contextId = "00000000-0000-4000-8000-000000000001", otherId = "00000000-0000-4000-8000-000000000002", deviceId = "00000000-0000-4000-8000-000000000010";
const account = { projectId: "synthetic-recovery", uid: "owner" };
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
async function put(namespace: string, id: string, overrides = {}) {
  const db = await openLocalDatabase(), tx = db.transaction("records", "readwrite"), complete = done(tx);
  const row = { key: `deletion:${namespace}:${id}:context`, namespace, kind: "deletion", contextId: id, attempts: 2, paused: true, nextAttemptAt: 9000, ...overrides };
  tx.objectStore("records").put(row); await complete; db.close(); return row;
}
async function rows() { const db = await openLocalDatabase(); const data = await result(db.transaction("records").objectStore("records").getAll()); db.close(); return data; }
it("atomically recovers an allowed legacy deletion once across tabs without changing unrelated stored data", async () => {
  const box = new DurableOutbox(account), second = new DurableOutbox(account);
  await applyLocalAccess(box.namespace, { id: deviceId, mode: "all", version: 1 }, []);
  const old = await put(box.namespace, contextId);
  await box.enqueue({ contextId: otherId, itemId: deviceId, title: "Keep attachment", content: { kind: "attachment", name: "synthetic.bin", size: 3, contentType: "application/octet-stream" }, bytes: new Uint8Array([1,2,3]), device: { id: deviceId, name: "Test" }, createsContext: true });
  const db = await openLocalDatabase(), tx = db.transaction("drafts", "readwrite"), complete = done(tx);
  tx.objectStore("drafts").put({ key: "draft:unrelated", namespace: box.namespace, text: "Keep draft", id: otherId }); await complete; db.close();
  const before = (await rows()).filter(row => row.key !== old.key);
  expect(typeof box.recoverLegacyDeletions).toBe("function");
  const recovered = await Promise.all([box.recoverLegacyDeletions(), second.recoverLegacyDeletions()]);
  expect(recovered.reduce((a,b) => a+b, 0)).toBe(1);
  expect(await box.deletions()).toEqual([expect.objectContaining({ attempts: 2, paused: false, nextAttemptAt: 0, recoveryVersion: 1 })]);
  const stale = old as never;
  await box.failDeletion(stale, true, 0, new PublishFailure("must not be stored: synthetic token", false, 0, { category: "access", httpStatus: 404 }));
  expect(await second.recoverLegacyDeletions()).toBe(0);
  expect(await box.deletions()).toEqual([expect.objectContaining({ paused: true, recoveryVersion: 1, errorCategory: "access", httpStatus: 404 })]);
  expect((await rows()).filter(row => row.key !== old.key)).toEqual(before);
  expect(JSON.stringify(await rows())).not.toContain("synthetic token");
  const check = await openLocalDatabase(); expect(await result(check.transaction("drafts").objectStore("drafts").get("draft:unrelated"))).toMatchObject({ text: "Keep draft" }); check.close(); box.close(); second.close();
});
it("requires an established current local policy and leaves disallowed or current-version deletions paused", async () => {
  const box = new DurableOutbox(account);
  await put(box.namespace, contextId); await put(box.namespace, otherId, { recoveryVersion: 1 });
  expect(typeof box.recoverLegacyDeletions).toBe("function");
  expect(await box.recoverLegacyDeletions()).toBe(0);
  await applyLocalAccess(box.namespace, { id: deviceId, mode: "own", version: 1 }, [otherId]);
  expect(await box.recoverLegacyDeletions()).toBe(0);
  expect((await rows()).filter(row => row.kind === "deletion").every(row => row.paused)).toBe(true); box.close();
});
it("tags fresh deletion records so a permanent failure stays paused after startup", async () => {
  const box = new DurableOutbox(account); await applyLocalAccess(box.namespace, { id: deviceId, mode: "all", version: 1 }, []);
  await box.requestDeletion(contextId); const [fresh] = await box.deletions();
  expect(fresh).toMatchObject({ recoveryVersion: 1 });
  await box.failDeletion(fresh!, true, 0, new PublishFailure("private body", false, 0, { category: "auth", httpStatus: 401 }));
  expect(await box.recoverLegacyDeletions()).toBe(0); expect(await box.deletions()).toEqual([expect.objectContaining({ paused: true, errorCategory: "auth", httpStatus: 401 })]); box.close();
});
