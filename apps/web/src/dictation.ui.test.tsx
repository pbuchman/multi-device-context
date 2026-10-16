// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDictation } from "./use-dictation.js";
import type { DictationBridge, DictationStatus, EditorSnapshot } from "./dictation.js";
import type { CloudSnapshot } from "./cloud.js";
import type { ItemRecord } from "./model.js";
const chat = "00000000-0000-4000-8000-000000000001", message = "00000000-0000-4000-8000-000000000002", id = "00000000-0000-4000-8000-000000000003";
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function tick(ms = 150) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function harness(text = "", start = text.length, end = start, synchronousAck = false) {
 let editor: EditorSnapshot = { chatId: chat, revision: 1, text, start, end, code: false, focused: true };
 let state: DictationStatus = { id, phase: "begin" }, listener: ((value: CloudSnapshot<ItemRecord>) => void) | undefined;
 let revoked: ((id: string) => void) | undefined;
 const bridge: DictationBridge = { authorize: async () => {}, subscribeRevoked: value => {revoked=value;return()=>{revoked=undefined};}, read: vi.fn(async () => state), report: vi.fn(async value => { if (state.id === value.id) state = { id, phase: value.phase }; }) };
 const stopWatch = vi.fn();
 const send = vi.fn(async (_id: string, _snapshot: EditorSnapshot, _authority: import("./dictation.js").DictationAuthority) => ({ contextId: chat, itemId: message }));
 function Harness() { useDictation({ bridge, read: () => editor, eligible: () => true, send, watch: (_, emit) => { listener = emit; if (synchronousAck) emit({fromCache:false,hasPendingWrites:false,records:[{id:message,contextId:chat,content:{kind:"text",text:"x"},device:{id:message,name:"fixture"},createdAt:1,ready:true,syncState:"synced"}]}); return stopWatch; } }); return <textarea aria-label="fixture" defaultValue={text} />; }
 const mounted = render(<Harness />);
 return { bridge, send, stopWatch, mounted, revokeNative() {revoked?.(id);}, get editor() { return editor; }, edit(value: Partial<EditorSnapshot>) { editor = { ...editor, ...value }; }, phase(phase: string) { state = { id, phase }; }, ack(fromCache = false, pending = false, item = message) { listener?.({ fromCache, hasPendingWrites: pending, records: [{ id: item, contextId: chat, content: { kind: "text", text: "result" }, device: { id: message, name: "fixture" }, createdAt: 1, ready: true, syncState: "synced" }] }); } };
}
async function complete(t: ReturnType<typeof harness>, inserted = "words") {
 await tick(); expect(t.bridge.report).toHaveBeenCalledWith(expect.objectContaining({ phase: "prepared", contextId: chat, revision: 1 }));
 t.phase("recording"); await tick(); t.phase("processing"); await tick();
 const before = t.editor;
 t.edit({ text: before.text.slice(0, before.start) + inserted + before.text.slice(before.end), start: before.start + inserted.length, end: before.start + inserted.length, revision: 2 });
 t.phase("complete"); await tick(900);
}
it.each([["",0,0], ["prior draft",11,11], ["abcdef",2,2], ["abcdef",2,4]] as const)("sends whole message once from captured editor %s/%s/%s and acknowledges only exact server item", async (text,start,end) => {
 const t = harness(text,start,end); await complete(t,"XY");
 expect(t.send).toHaveBeenCalledOnce(); expect(t.send.mock.calls[0]?.[1]).toMatchObject({ chatId: chat, text: text.slice(0,start)+"XY"+text.slice(end) });
 expect(t.bridge.report).toHaveBeenCalledWith({ id, phase: "queued", contextId: chat, itemId: message });
 act(() => { t.ack(true); t.ack(false,true); t.ack(false,false,id); });
 expect(t.bridge.report).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "synced" }));
 act(() => t.ack()); expect(t.bridge.report).toHaveBeenCalledWith({ id, phase: "synced", contextId: chat, itemId: message });
});
it("Done alone expires without replacing draft or sending", async () => {
 const t=harness("prior"); await tick();t.phase("recording");await tick();t.phase("processing");await tick();t.phase("complete");await tick(60_150);
 expect(t.send).not.toHaveBeenCalled(); expect(t.editor.text).toBe("prior");expect(t.bridge.report).toHaveBeenCalledWith({id,phase:"cancelled"});
});
it("human keyboard/paste/composition cancels before insertion can authorize a send", async () => {
 const t=harness("prior");await tick();t.phase("recording");await tick();t.phase("processing");await tick();
 fireEvent.keyDown(document,{key:"x"});t.edit({text:"prior words",revision:2,start:11,end:11});t.phase("complete");await tick(1200);
 expect(t.send).not.toHaveBeenCalled();expect(t.editor.text).toBe("prior words");
});
it("navigation after offline queue cancels late acknowledgement authority", async () => {
 const t=harness();await complete(t);expect(t.send).toHaveBeenCalledOnce();t.edit({chatId:id});await tick();act(()=>t.ack());
 expect(t.bridge.report).not.toHaveBeenCalledWith(expect.objectContaining({phase:"synced"}));expect(t.bridge.report).toHaveBeenCalledWith({id,phase:"cancelled"});
});
it("offline queue can acknowledge late while the original session remains valid", async () => {
 const t=harness();await complete(t);act(()=>t.ack(true,true));await tick(120_000);expect(t.send).toHaveBeenCalledOnce();
 act(()=>t.ack());expect(t.bridge.report).toHaveBeenCalledWith(expect.objectContaining({phase:"synced",itemId:message}));
});
it("renderer restart never reconstructs or replays queued auto-send authority", async () => {
 const t=harness();await complete(t);t.mounted.unmount();expect(t.send).toHaveBeenCalledOnce();
 const next=harness("preserved");next.phase("queued");await tick(3000);expect(next.send).not.toHaveBeenCalled();
});

it("stops a synchronously acknowledged item listener exactly once and reports once", async () => {
 const t=harness("",0,0,true);await complete(t);expect(t.stopWatch).toHaveBeenCalledOnce();
 act(()=>{t.ack();t.ack();});expect(vi.mocked(t.bridge.report).mock.calls.filter(([value])=>value.phase==="synced")).toHaveLength(1);
 t.mounted.unmount();expect(t.stopWatch).toHaveBeenCalledOnce();
});

it("native-only revocation aborts send immediately while polling is awaiting it", async () => {
 const t=harness();let release!:()=>void;let signal:AbortSignal|undefined;
 const pending=new Promise<void>(resolve=>{release=resolve});
 t.send.mockImplementation(async(_id,_snapshot,authority)=>{signal=authority.signal;await pending;if(authority.signal.aborted)throw new Error("revoked");return {contextId:chat,itemId:message};});
 await complete(t);expect(t.send).toHaveBeenCalledOnce();expect(signal?.aborted).toBe(false);
 act(()=>t.revokeNative());expect(signal?.aborted).toBe(true);
 await act(async()=>{release();await Promise.resolve();});
 expect(t.bridge.report).not.toHaveBeenCalledWith(expect.objectContaining({phase:"queued"}));
});
