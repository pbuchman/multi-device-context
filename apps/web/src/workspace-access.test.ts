// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ShareDraft } from "./model.js";
import type { ActiveSession } from "./auth.js";
import { applyLocalAccess } from "./local-access.js";
const state = vi.hoisted(() => ({ device: { id: "11111111-1111-4111-8111-111111111111", name: "Verified Phone", platform: "android" as const, mode: "all" as "own" | "all", version: 1, createdAt: 1, updatedAt: 1 }, listener: undefined as undefined | ((value: unknown) => void), failed: undefined as undefined | (() => void), deleteItem: vi.fn(async()=>{}), publish: vi.fn(async()=>{}), invalidated: vi.fn() }));
vi.mock("./history.js",()=>({prepareHistory:async()=>{}}));
vi.mock("./cloud.js",async importOriginal=>({ ...await importOriginal<typeof import("./cloud.js")>(), FirebaseCloud: class {
 constructor(){} refreshContexts=async()=>({records:[],fromCache:false,hasPendingWrites:false}); refreshDevice=async()=>state.device;
 subscribeDevice=(emit:(value:unknown)=>void,fail:()=>void)=>{state.listener=emit;state.failed=fail;return()=>{state.listener=undefined;state.failed=undefined;}};
 deletionMarkers=async()=>({contexts:[],items:[]});publish=state.publish;deleteContext=async()=>{};deleteItem=state.deleteItem;invalidate=state.invalidated;
} }));
import { buildServices } from "./App.js";
afterEach(()=>{vi.clearAllMocks();localStorage.clear();});
function session():ActiveSession { return { device: {...state.device}, uid:crypto.randomUUID(), config:{firebase:{projectId:"access-test"},appOrigin:"https://app.example.test"}, firebaseApp:{}, platform:{kind:"browser",dispose(){}}, viewer:{uid:"user",name:"Me"},accessToken:async()=>"firebase",disposeData:async()=>{},signOut:async()=>{} } as unknown as ActiveSession; }
it("uses the verified device, starts paused, and invalidates the old workspace synchronously on policy change",async()=>{
 localStorage.setItem("mdc-browser-device-id","22222222-2222-4222-8222-222222222222");
 const changed=vi.fn(), bundle=await buildServices(session(),changed);
 expect(bundle.services.device).toEqual({id:state.device.id,name:state.device.name});expect(state.publish).not.toHaveBeenCalled();
 state.listener!({...state.device,mode:"own",version:2});
 expect(bundle.services.accessActive!()).toBe(false);expect(changed).toHaveBeenCalledOnce();
 await bundle.services.drain();expect(state.publish).not.toHaveBeenCalled();bundle.dispose();
});
it("an access change committed by another tab fences this workspace before any further publishing",async()=>{
 const changed=vi.fn(),bundle=await buildServices(session(),changed);
 await applyLocalAccess(bundle.services.outbox.namespace,{...state.device,mode:"own",version:2},[]);
 await vi.waitFor(()=>expect(bundle.services.accessActive!()).toBe(false));expect(changed).toHaveBeenCalledOnce();bundle.dispose();
});
it("suppresses policy-error reconnect while reviewed account sign-out owns shutdown",async()=>{
 const active=session();active.signOut=async cleanup=>{state.failed!();await cleanup?.();};const changed=vi.fn(),bundle=await buildServices(active,changed);
 const review=await bundle.services.accountSignOut!.prepare();await bundle.services.accountSignOut!.confirm(review);
 expect(changed).not.toHaveBeenCalled();bundle.dispose();
});
it("accepts name-only updates without invalidation and preserves existing device snapshots",async()=>{
 const changed=vi.fn(),active=session(),bundle=await buildServices(active,changed);
 const previous=bundle.services.device;const seen=vi.fn();const stop=bundle.services.subscribeDevice?.(seen);
 state.listener!({...state.device,name:"Office laptop",updatedAt:2});
 expect(bundle.services.device.name).toBe("Office laptop");expect(previous.name).toBe("Verified Phone");
 expect(seen).toHaveBeenCalledWith({id:state.device.id,name:"Office laptop"});
 expect(bundle.services.accessActive!()).toBe(true);expect(changed).not.toHaveBeenCalled();expect(state.invalidated).not.toHaveBeenCalled();
 stop?.();bundle.dispose();
});

it("keeps durable queued names immutable when the active installation is renamed",async()=>{
 const bundle=await buildServices(session(),vi.fn());
 const draft:ShareDraft={contextId:crypto.randomUUID(),itemId:crypto.randomUUID(),title:"Before rename",content:{kind:"text",text:"Queued before"},device:bundle.services.device,createsContext:true};
 await bundle.services.outbox.enqueue(draft);
 state.listener!({...state.device,name:"New installation name",updatedAt:2});
 await bundle.services.outbox.enqueue({...draft,itemId:crypto.randomUUID(),title:"After rename",device:bundle.services.device});
 const queued=await bundle.services.outbox.list();expect(queued.find(record=>record.itemId===draft.itemId)?.device.name).toBe("Verified Phone");expect(queued.find(record=>record.itemId!==draft.itemId)?.device.name).toBe("New installation name");
 expect(draft.device.name).toBe("Verified Phone");bundle.dispose();
});

it("production services preserve conditional final-item deletion through both adapter boundaries",async()=>{
 const bundle=await buildServices(session(),vi.fn());
 bundle.services.resume?.();
 await bundle.services.remove!(crypto.randomUUID(),crypto.randomUUID(),true);
 await vi.waitFor(()=>expect(state.deleteItem).toHaveBeenCalledWith(expect.any(String),expect.any(String),true));bundle.dispose();
});

it("production initialization resumes legacy deletion only after verified access is installed",async()=>{
 const active=session();const {DurableOutbox}=await import("./outbox.js");const {openLocalDatabase,done}=await import("./local-db.js");
 const box=new DurableOutbox({projectId:active.config.firebase.projectId,uid:active.uid});
 const contextId=crypto.randomUUID(), key=`deletion:${box.namespace}:${contextId}:context`;
 const db=await openLocalDatabase(),tx=db.transaction("records","readwrite"),complete=done(tx);
 tx.objectStore("records").put({key,namespace:box.namespace,kind:"deletion",contextId,attempts:1,paused:true,nextAttemptAt:1000});await complete;db.close();
 const bundle=await buildServices(active,vi.fn());
 expect(await box.deletions()).toEqual([expect.objectContaining({paused:false,nextAttemptAt:0,recoveryVersion:1})]);
 bundle.dispose();box.close();
});
