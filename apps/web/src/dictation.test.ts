import { beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DictationSession, insertedAtSelection, messageAcknowledged, watchDictationItems, type EditorSnapshot } from "./dictation.js";
import { DurableOutbox, OutboxRunner } from "./outbox.js";
import type { ShareDraft } from "./model.js";
const chatId = "00000000-0000-4000-8000-000000000001", itemId = "00000000-0000-4000-8000-000000000002", sessionId = "00000000-0000-4000-8000-000000000003";
const before = (text = "", start = text.length, end = start): EditorSnapshot => ({ chatId, revision: 1, text, start, end, code: false, focused: true });
const after = (base: EditorSnapshot, inserted: string): EditorSnapshot => ({ ...base, revision: 2, text: base.text.slice(0, base.start) + inserted + base.text.slice(base.end), start: base.start + inserted.length, end: base.start + inserted.length });
const draft = (): ShareDraft => ({ contextId: chatId, itemId, title: "Dictation", content: { kind: "text", text: "previous + transcript" }, device: { id: itemId, name: "Synthetic Android" }, createsContext: true });
const authority = () => ({ validate: async () => {}, current: () => true, signal: new AbortController().signal });
beforeEach(() => Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() }));
it.each([["", 0, 0], ["prior draft", 11, 11], ["abcd", 2, 2], ["abcdef", 2, 4]] as const)("accepts one insertion or range replacement: %s %s %s", (text, start, end) => {
 const base = before(text, start, end), next = after(base, "XY");
 expect(insertedAtSelection(base, next)).toBe(true);
 const session = new DictationSession(sessionId, base); session.recording(); session.finishing(1000);
 expect(session.ready(next, 1200)).toBe(false); expect(session.ready(next, 1800)).toBe(true);
 expect(next.text).toBe(text.slice(0, start) + "XY" + text.slice(end));
});
it("does not send on Done without insertion, disappearing controls, or global sync", () => {
 const s = new DictationSession(sessionId, before()); s.recording(); s.finishing(1000);
 expect(s.ready(before(), 5000)).toBe(false); expect(s.ready(before(), 61000)).toBe(false); expect(s.invalid).toBe(true);
});
it("permits late insertion within the original 60 second finish deadline", () => {
 const base = before("draft "), s = new DictationSession(sessionId, base); s.recording(); s.finishing(1000);
 expect(s.observe(base, 59000)).toBe(true); expect(s.ready(after(base, "words"), 59900)).toBe(false); expect(s.ready(after(base, "words"), 60500)).toBe(true);
});
it.each(["navigation", "code mode", "focus", "manual edit", "caret", "cancel"])("fails closed on %s", kind => {
 const base = before("prefix suffix", 7), s = new DictationSession(sessionId, base); s.recording(); s.finishing(1000);
 let next = after(base, "words");
 if (kind === "navigation") next.chatId = itemId;
 if (kind === "code mode") next.code = true;
 if (kind === "focus") next.focused = false;
 if (kind === "manual edit") next.text = "changed outside range";
 if (kind === "caret") next.start = next.end = 0;
 if (kind === "cancel") s.interfere();
 expect(s.ready(next, 2000)).toBe(false); expect(s.invalid).toBe(true);
});
it("rejects revisions/streaming and text changes during recording", () => {
 const base = before("prior"), s = new DictationSession(sessionId, base); s.recording();
 expect(s.observe(after(base, "first"), 1000)).toBe(false);
 const t = new DictationSession(sessionId, base); t.recording(); t.finishing(1000);
 expect(t.observe(after(base, "first"), 1100)).toBe(true); expect(t.ready(after(base, "second"), 1800)).toBe(false);
});
it("a fresh process has no old session authority", () => {
 const fresh = new DictationSession(sessionId, before()); expect(fresh.phase).toBe("prepared"); expect(fresh.ready(after(before(), "late"), 9000)).toBe(false);
});
it("caret-only movement after insertion invalidates the settled transcript", () => {
 const base=before("prior"), s=new DictationSession(sessionId,base);s.recording();s.finishing(1000);
 const next=after(base," words");expect(s.observe(next,1100)).toBe(true);
 expect(s.ready({...next,start:1,end:1},1800)).toBe(false);expect(s.invalid).toBe(true);
});
it("only the exact server-confirmed message acknowledges; cache/pending/other messages never do", () => {
 const item = { id: itemId, contextId: chatId, content: { kind: "text" as const, text: "x" }, device: draft().device, createdAt: 1, ready: true, syncState: "synced" as const };
 const snap = { records: [item], fromCache: false, hasPendingWrites: false };
 expect(messageAcknowledged(snap, chatId, itemId)).toBe(true);
 for (const value of [{ ...snap, fromCache: true }, { ...snap, hasPendingWrites: true }, { ...snap, records: [{ ...item, id: sessionId }] }, { ...snap, records: [{ ...item, syncState: "pending" as const }] }]) expect(messageAcknowledged(value, chatId, itemId)).toBe(false);
});
it("atomically maps session to one exact message across duplicates/reopen and normal offline retry", async () => {
 const account = { projectId: "dictation-test", uid: "user" }, box = new DurableOutbox(account);
 const results = await Promise.all([box.enqueueDictation(sessionId, draft(), authority()), box.enqueueDictation(sessionId, { ...draft(), itemId: sessionId }, authority())]);
 expect(results[0]!.itemId).toBe(results[1]!.itemId); expect(await box.count()).toBe(1);
 box.close(); const reopened = new DurableOutbox(account);
 expect((await reopened.enqueueDictation(sessionId, { ...draft(), itemId: sessionId }, authority())).created).toBe(false);
 let offline = true; const runner = new OutboxRunner(reopened, { publish: async () => { if (offline) throw new Error("offline"); } });
 await runner.drain(); expect(await reopened.count()).toBe(1);
 offline = false; await reopened.retry(); await runner.drain(); expect(await reopened.count()).toBe(0);
 expect((await reopened.enqueueDictation(sessionId, draft(), authority())).created).toBe(false); reopened.close();
});
it("rechecks authority after every IndexedDB wait and rolls back the marker and action", async () => {
 const box = new DurableOutbox({ projectId: "dictation-test", uid: "user" });
 for (const revokeAt of [1, 2, 3, 4, 5, 6, 7]) {
  let checks = 0; const control = new AbortController();
  await expect(box.enqueueDictation(sessionId, draft(), { validate: async () => {}, current: () => ++checks < revokeAt, signal: control.signal })).rejects.toThrow("revoked");
  expect(await box.count()).toBe(0);
 }
 expect((await box.enqueueDictation(sessionId, draft(), authority())).created).toBe(true); box.close();
});
it("an abort during the open-database await cannot leave a queued action or marker", async () => {
 const box = new DurableOutbox({ projectId: "dictation-test", uid: "user" }), control = new AbortController();
 const waiting = box.enqueueDictation(sessionId, draft(), { validate: async () => {}, current: () => true, signal: control.signal }); control.abort();
 await expect(waiting).rejects.toThrow("revoked"); expect(await box.count()).toBe(0);
 expect((await box.enqueueDictation(sessionId, draft(), authority())).created).toBe(true); box.close();
});

it("waits for new offline chat ownership before starting its exact-item listener", () => {
 let contexts!: Parameters<Parameters<typeof watchDictationItems>[0]["subscribeContexts"]>[0];
 const stoppedContext=vi.fn(), stoppedItems=vi.fn(), subscribeItems=vi.fn(()=>stoppedItems);
 const cloud={subscribeContexts: (emit: typeof contexts)=>{contexts=emit;return stoppedContext;}, subscribeItems};
 const stop=watchDictationItems(cloud,chatId,()=>{},()=>{});
 const snapshot={records:[{id:chatId,title:"new",createdAt:1,updatedAt:1,syncState:"synced" as const}],fromCache:false,hasPendingWrites:false};
 contexts({...snapshot,fromCache:true});contexts({...snapshot,hasPendingWrites:true});expect(subscribeItems).not.toHaveBeenCalled();
 contexts(snapshot);expect(subscribeItems).toHaveBeenCalledOnce();expect(stoppedContext).toHaveBeenCalledOnce();
 stop();stop();expect(stoppedContext).toHaveBeenCalledOnce();expect(stoppedItems).toHaveBeenCalledOnce();
});

it("native revocation during final async IDB admission aborts both marker and action", async () => {
 const box=new DurableOutbox({projectId:"dictation-test",uid:"user"}),control=new AbortController();let calls=0,release!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve});
 const queued=box.enqueueDictation(sessionId,draft(),{current:()=>true,signal:control.signal,validate:async()=>{if(++calls===2)await pending;}});
 await vi.waitFor(()=>expect(calls).toBe(2));control.abort();release();await expect(queued).rejects.toThrow();expect(await box.count()).toBe(0);
 expect((await box.enqueueDictation(sessionId,draft(),authority())).created).toBe(true);box.close();
});
it("denied native final admission and its 1500ms timeout roll back without a marker", async () => {
 const box=new DurableOutbox({projectId:"dictation-test",uid:"user"});
 let calls=0;await expect(box.enqueueDictation(sessionId,draft(),{...authority(),validate:async()=>{if(++calls===2)throw new Error("lease died");}})).rejects.toThrow("lease died");expect(await box.count()).toBe(0);
 calls=0;await expect(box.enqueueDictation(sessionId,draft(),{...authority(),validate:async()=>{if(++calls===2)await new Promise<void>(()=>{});}})).rejects.toThrow("timed out");expect(await box.count()).toBe(0);
 expect((await box.enqueueDictation(sessionId,draft(),authority())).created).toBe(true);box.close();
});
