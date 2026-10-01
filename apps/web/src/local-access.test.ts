import { expect, it } from "vitest";
import { DurableOutbox } from "./outbox.js";
import { DraftStore } from "./drafts.js";
import { applyLocalAccess } from "./local-access.js";
const ownDevice = { id: "11111111-1111-4111-8111-111111111111", name: "Phone" };
const policy = (mode: "own" | "all", version: number) => ({ ...ownDevice, mode, version });
function fixture() { const outbox = new DurableOutbox({ projectId: "access", uid: crypto.randomUUID() }); return { outbox, drafts: new DraftStore(outbox.namespace) }; }
const draft = (contextId: string, createsContext = false) => ({ contextId, itemId: crypto.randomUUID(), title: "Draft", content: { kind: "text" as const, text: "unsent" }, device: ownDevice, createsContext });
it("prunes foreign work atomically without marking live contexts deleted, preserving own and newly created work", async () => {
 const { outbox, drafts } = fixture(); const own = crypto.randomUUID(), foreign = crypto.randomUUID(), fresh = crypto.randomUUID();
 await applyLocalAccess(outbox.namespace, policy("all", 1), [own]);
 await outbox.enqueueBatch([draft(own), draft(foreign), draft(fresh, true)]);
 for (const id of [own, foreign]) await drafts.save(id, { text: "typed", code: false, local: false, title: "Title", createdAt: 1 });
 await applyLocalAccess(outbox.namespace, policy("own", 2), [own]);
 expect((await outbox.list()).map(r => r.contextId).sort()).toEqual([own, fresh].sort());
 expect(Object.keys(await drafts.list())).toEqual([own]);
 expect(await drafts.isRemoved(foreign)).toBe(false);
 expect((await outbox.cancelled()).contexts).not.toContain(foreign);
 await expect(outbox.enqueue(draft(foreign))).rejects.toThrow(/access/i);
 await expect(drafts.save(foreign, { text: "late write", code: false, local: false, title: "Old", createdAt: 1 })).rejects.toThrow(/access/i);
 await applyLocalAccess(outbox.namespace, policy("all", 3), []);
 await expect(outbox.enqueue(draft(foreign))).resolves.toBeUndefined(); outbox.close();
});
it("cannot infer context ownership from a queued message author or reopen access with an older policy", async () => {
 const { outbox } = fixture(); const foreign = crypto.randomUUID();
 await applyLocalAccess(outbox.namespace, policy("all", 1), []); await outbox.enqueue(draft(foreign));
 await applyLocalAccess(outbox.namespace, policy("own", 3), []); await applyLocalAccess(outbox.namespace, policy("all", 2), []);
 expect(await outbox.list()).toEqual([]); await expect(outbox.enqueue(draft(foreign))).rejects.toThrow(/access/i); outbox.close();
});
it("retains real deletion fences and native acknowledgement while dropping foreign deletion intents", async () => {
 const { outbox } = fixture(); const foreign = crypto.randomUUID(), actualDeleted = crypto.randomUUID(), request = crypto.randomUUID();
 await applyLocalAccess(outbox.namespace, policy("all", 1), []);
 await outbox.enqueueNativeRequest(request, [draft(crypto.randomUUID(), true)]);
 await outbox.requestDeletion(foreign); await outbox.removeContext(actualDeleted);
 await applyLocalAccess(outbox.namespace, policy("own", 2), []);
 expect(await outbox.deletions()).toEqual([]); expect((await outbox.cancelled()).contexts).toContain(actualDeleted);
 expect(await outbox.hasNativeRequest(request)).toBe(true); outbox.close();
});

it("preserves but quarantines existing drafts and queue during first enrollment until ownership is confirmed", async () => {
 const { outbox, drafts }=fixture(); const existing=crypto.randomUUID();
 await outbox.enqueue(draft(existing)); await drafts.save(existing,{text:"keep my draft",code:false,local:false,title:"Existing",createdAt:1});
 await applyLocalAccess(outbox.namespace,policy("own",1),[]);
 expect(await outbox.list()).toEqual([]); expect(await drafts.list()).toEqual({});
 await applyLocalAccess(outbox.namespace,policy("own",1),[existing]);
 expect((await outbox.list())[0]?.contextId).toBe(existing); expect((await drafts.list())[existing]?.text).toBe("keep my draft");outbox.close();
});
it("does not acknowledge or partially save a native batch rejected by the policy fence", async()=>{
 const {outbox}=fixture();await applyLocalAccess(outbox.namespace,policy("own",1),[]);const request=crypto.randomUUID();
 await expect(outbox.enqueueNativeRequest(request,[draft(crypto.randomUUID(),true),draft(crypto.randomUUID())])).rejects.toThrow(/access/i);
 expect(await outbox.hasNativeRequest(request)).toBe(false);expect(await outbox.list()).toEqual([]);outbox.close();
});
