// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { DraftStore, emptyDraft } from "./drafts.js";
import { openLocalDatabase, done, result } from "./local-db.js";
import { createAccountSignOut, SignOutError } from "./account-signout.js";

const namespace = "project:user", other = "project:other";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); localStorage.clear(); });
async function record(key: string, kind = "action", ns = namespace) {
  const db = await openLocalDatabase();
  try { const tx = db.transaction("records", "readwrite"); const complete = done(tx); tx.objectStore("records").put({ key, kind, namespace: ns }); await complete; }
  finally { db.close(); }
}
async function records(ns = namespace) {
  const db = await openLocalDatabase();
  try { return await result(db.transaction("records", "readonly").objectStore("records").index("namespace").getAll(ns)); }
  finally { db.close(); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const restore = vi.fn();
  const ports = {
    namespace,
    readNativeRequests: vi.fn(async () => [{ id: "native-one" }]),
    pause: vi.fn(() => restore),
    settle: vi.fn(async () => {}),
    signOut: vi.fn(async (purge: () => Promise<void>) => { await purge(); }),
  };
  return { ports, restore, flow: createAccountSignOut(ports) };
}
describe("account sign-out transaction", () => {
  it("rejects an unsupported native implementation before reading data or invalidating auth", async () => {
    const f = fixture(); await record("retained");
    const flow = createAccountSignOut({ ...f.ports, checkAvailable: () => { throw new Error("Update this desktop app before signing out"); } });
    await expect(flow.prepare()).rejects.toMatchObject({ stage: "preparation", sessionMayBeInvalid: false });
    expect(f.ports.readNativeRequests).not.toHaveBeenCalled(); expect(f.ports.pause).not.toHaveBeenCalled(); expect(f.ports.signOut).not.toHaveBeenCalled();
    expect(flow.locked).toBe(false); expect(await records()).toHaveLength(1);
  });
  it("rechecks native compatibility immediately before confirmation without freezing an unsupported session", async () => {
    const f = fixture(), checkAvailable = vi.fn();
    const flow = createAccountSignOut({ ...f.ports, checkAvailable });
    const summary = await flow.prepare(); checkAvailable.mockImplementationOnce(() => { throw new Error("Update required"); });
    await expect(flow.confirm(summary)).rejects.toMatchObject({ stage: "preparation", sessionMayBeInvalid: false });
    expect(flow.locked).toBe(false); expect(f.ports.pause).not.toHaveBeenCalled(); expect(f.ports.signOut).not.toHaveBeenCalled();
  });
  it("counts drafts, queued items, native requests and deletion intents separately without deleting anything", async () => {
    const f = fixture();
    const drafts = new DraftStore(namespace);
    await drafts.save(id, { ...emptyDraft(), text: "Keep my draft" });
    await drafts.save("empty", emptyDraft());
    await record("share"); await record("delete", "deletion"); await record("marker", "native");
    const summary = await f.flow.prepare();
    expect(summary).toMatchObject({ drafts: 1, webShares: 1, nativeBatches: 1, deletions: 1 });
    expect(Object.values(await drafts.list()).some(d => d.text === "Keep my draft")).toBe(true);
    expect(await records()).toHaveLength(3);
    expect(f.ports.pause).not.toHaveBeenCalled();
    expect(f.ports.signOut).not.toHaveBeenCalled();
  });
  it("does not pause or erase when summary reading fails", async () => {
    const f = fixture(); await record("share");
    f.ports.readNativeRequests.mockRejectedValueOnce(new Error("native unavailable"));
    await expect(f.flow.prepare()).rejects.toMatchObject({ stage: "preparation", sessionMayBeInvalid: false });
    expect(await records()).toHaveLength(1); expect(f.ports.pause).not.toHaveBeenCalled();
  });
  it("settles draft writes before both reads and pauses only after explicit confirmation", async () => {
    const f = fixture(); const settle = vi.fn(async () => { await new DraftStore(namespace).save(id, { ...emptyDraft(), text: "latest" }); });
    const summary = await f.flow.prepare(settle); expect(summary.drafts).toBe(1);
    const result = await f.flow.confirm(summary, settle);
    expect(result.status).toBe("complete"); expect(settle).toHaveBeenCalledTimes(2);
    expect(f.ports.pause).toHaveBeenCalledTimes(1); expect(f.restore).not.toHaveBeenCalled();
  });
  it("requires reconfirmation for new pending content even if the count is unchanged", async () => {
    const f = fixture(); await record("old"); const summary = await f.flow.prepare();
    const db = await openLocalDatabase(); const tx = db.transaction("records", "readwrite"); const complete = done(tx); tx.objectStore("records").delete("old"); tx.objectStore("records").put({ key: "new", kind: "action", namespace }); await complete; db.close();
    const changed = await f.flow.confirm(summary);
    expect(changed.status).toBe("changed"); expect(f.ports.signOut).not.toHaveBeenCalled(); expect(f.restore).toHaveBeenCalledOnce(); expect(f.flow.locked).toBe(false);
    if (changed.status === "changed") expect((await f.flow.confirm(changed.summary)).status).toBe("complete");
  });
  it("reconfirms a native arrival while settling and retains the original account data", async () => {
    const f = fixture(); const summary = await f.flow.prepare();
    f.ports.settle.mockImplementationOnce(async () => { f.ports.readNativeRequests.mockResolvedValue([{ id: "native-one" }, { id: "native-two" }]); });
    const changed = await f.flow.confirm(summary);
    expect(changed).toMatchObject({ status: "changed", summary: { nativeBatches: 2 } });
    expect(f.ports.signOut).not.toHaveBeenCalled();
  });
  it("does not clear on preparation failure and restores only the pre-auth suspension", async () => {
    const f = fixture(); await record("share"); const summary = await f.flow.prepare();
    f.ports.settle.mockRejectedValueOnce(new Error("write unsettled"));
    await expect(f.flow.confirm(summary)).rejects.toMatchObject({ stage: "preparation", sessionMayBeInvalid: false });
    expect(f.restore).toHaveBeenCalledOnce(); expect(f.flow.locked).toBe(false); expect(await records()).toHaveLength(1);
  });
  it("keeps web drafts and outbox on auth failure without resuming an invalid session, then retries", async () => {
    const f = fixture(); await new DraftStore(namespace).save(id, { ...emptyDraft(), text: "retained" }); await record("share");
    const summary = await f.flow.prepare(); f.ports.signOut.mockRejectedValueOnce(new Error("native may already be cleared"));
    await expect(f.flow.confirm(summary)).rejects.toMatchObject({ stage: "auth", sessionMayBeInvalid: true });
    expect(f.flow.locked).toBe(true); expect(f.restore).not.toHaveBeenCalled(); expect(await records()).toHaveLength(1); expect((await new DraftStore(namespace).list())[id]?.text).toBe("retained");
    await f.flow.retry(); expect(await records()).toHaveLength(0); expect(await new DraftStore(namespace).list()).toEqual({});
  });
  it("purges only this namespace after authentication and before browser handoff", async () => {
    const f = fixture(); const events: string[] = [];
    await new DraftStore(namespace).save(id, { ...emptyDraft(), text: "discard" }); await new DraftStore(other).save(id, { ...emptyDraft(), text: "other user" });
    await record("share"); await record("delete", "deletion"); await record("other-share", "action", other);
    localStorage.setItem(`mdc-drafts:${namespace}`, "legacy");
    f.ports.signOut.mockImplementationOnce(async purge => { events.push("auth"); expect(await records()).toHaveLength(2); await purge(); events.push("handoff"); expect(await records()).toHaveLength(0); });
    await f.flow.confirm(await f.flow.prepare());
    expect(events).toEqual(["auth", "handoff"]); expect(await records(other)).toHaveLength(1); expect((await new DraftStore(other).list())[id]?.text).toBe("other user"); expect(localStorage.getItem(`mdc-drafts:${namespace}`)).toBeNull();
  });
  it("coalesces repeated confirmation while local work settles", async () => {
    const f = fixture(); const gate = deferred(); f.ports.settle.mockReturnValueOnce(gate.promise); const summary = await f.flow.prepare();
    const first = f.flow.confirm(summary), second = f.flow.confirm(summary); gate.resolve();
    expect(await first).toEqual(await second); expect(f.ports.signOut).toHaveBeenCalledOnce();
  });
  it("rejects a summary from another coordinator/account before suspension", async () => {
    const f = fixture(), second = fixture(); const summary = await f.flow.prepare();
    await expect(second.flow.confirm(summary)).rejects.toBeInstanceOf(SignOutError); expect(second.ports.pause).not.toHaveBeenCalled();
  });
  it("reports a handoff failure after cleanup without falsely claiming data is retained", async () => {
    const f = fixture(); await record("share"); f.ports.signOut.mockImplementationOnce(async purge => { await purge(); throw new Error("navigation failed"); });
    await expect(f.flow.confirm(await f.flow.prepare())).rejects.toMatchObject({ stage: "handoff", sessionMayBeInvalid: true });
    expect(await records()).toHaveLength(0); expect(f.flow.locked).toBe(true); expect(f.restore).not.toHaveBeenCalled();
  });
  it("keeps cleanup failures typed when a changed inventory cannot be reread", async () => {
    const f = fixture(); await record("old"); const summary = await f.flow.prepare();
    f.ports.signOut.mockImplementationOnce(async purge => {
      await record("new"); f.ports.readNativeRequests.mockRejectedValueOnce(new Error("inbox unavailable")); await purge();
    });
    await expect(f.flow.confirm(summary)).rejects.toMatchObject({ stage: "cleanup", sessionMayBeInvalid: true });
    expect(await records()).toHaveLength(2); expect(f.flow.locked).toBe(true);
    expect(await f.flow.retry()).toMatchObject({ status: "changed", summary: { webShares: 2 } });
  });
  it("does not repeat inventory or cleanup on a handoff retry", async () => {
    const f = fixture(); await record("old");
    f.ports.signOut.mockImplementationOnce(async purge => { await purge(); throw new Error("handoff"); });
    await expect(f.flow.confirm(await f.flow.prepare())).rejects.toMatchObject({ stage: "handoff" });
    f.ports.readNativeRequests.mockRejectedValue(new Error("not available after signout"));
    f.ports.signOut.mockImplementationOnce(async () => { throw new Error("still blocked"); });
    await expect(f.flow.retry()).rejects.toMatchObject({ stage: "handoff" });
    expect(await f.flow.retry()).toEqual({ status: "complete" });
  });
  it("does not replace the active snapshot through concurrent preparation", async () => {
    const f = fixture(); const gate = deferred(); const summary = await f.flow.prepare();
    f.ports.settle.mockReturnValueOnce(gate.promise);
    const confirming = f.flow.confirm(summary);
    await expect(f.flow.prepare()).rejects.toMatchObject({ stage: "preparation" });
    gate.resolve(); await confirming;
  });
  it("rolls back both stores if account cleanup fails partway through the transaction", async () => {
    const f = fixture(), drafts = new DraftStore(namespace);
    await drafts.save(id, { ...emptyDraft(), text: "retained" }); await record("share");
    const summary = await f.flow.prepare(), original = IDBObjectStore.prototype.delete;
    const failure = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function(this: IDBObjectStore, key) {
      if (this.name === "records") throw new Error("storage failure");
      return original.call(this, key);
    });
    try { await expect(f.flow.confirm(summary)).rejects.toMatchObject({ stage: "cleanup", sessionMayBeInvalid: true }); }
    finally { failure.mockRestore(); }
    expect((await drafts.list())[id]?.text).toBe("retained"); expect(await records()).toHaveLength(1);
    expect(await f.flow.retry()).toEqual({ status: "complete" });
  });
});
