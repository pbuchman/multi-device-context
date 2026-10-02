// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { ActiveSession } from "./auth.js";
import { applyLocalAccess } from "./local-access.js";
const state = vi.hoisted(() => ({ device: { id: "11111111-1111-4111-8111-111111111111", name: "Verified Phone", platform: "android" as const, mode: "all" as "own" | "all", version: 1, createdAt: 1, updatedAt: 1 }, listener: undefined as undefined | ((value: unknown) => void), failed: undefined as undefined | (() => void), publish: vi.fn(async()=>{}), invalidated: vi.fn() }));
vi.mock("./history.js",()=>({prepareHistory:async()=>{}}));
vi.mock("./cloud.js",async importOriginal=>({ ...await importOriginal<typeof import("./cloud.js")>(), FirebaseCloud: class {
 constructor(){} refreshContexts=async()=>({records:[],fromCache:false,hasPendingWrites:false}); refreshDevice=async()=>state.device;
 subscribeDevice=(emit:(value:unknown)=>void,fail:()=>void)=>{state.listener=emit;state.failed=fail;return()=>{state.listener=undefined;state.failed=undefined;}};
 deletionMarkers=async()=>({contexts:[],items:[]});publish=state.publish;deleteContext=async()=>{};deleteItem=async()=>{};invalidate=state.invalidated;
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
