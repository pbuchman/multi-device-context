// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import type { CloudSnapshot } from "./cloud.js";
import type { ContextRecord, ItemRecord } from "./model.js";

const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
const contexts: ContextRecord[] = [
  { id: alpha, title: "Alpha", createdAt: 1, updatedAt: 20, syncState: "synced" },
  { id: beta, title: "Beta", createdAt: 2, updatedAt: 10, syncState: "synced" },
];

afterEach(() => { cleanup(); localStorage.clear(); history.replaceState({}, "", "/"); });

function services(initialContexts = contexts) {
  let contextListener: ((snapshot: CloudSnapshot<ContextRecord>) => void) | undefined;
  let contextSnapshot: CloudSnapshot<ContextRecord> = {
    records: initialContexts,
    fromCache: initialContexts.some((context) => context.syncState === "cached"),
    hasPendingWrites: initialContexts.some((context) => context.syncState === "pending"),
  };
  const items = new Map<string, (snapshot: CloudSnapshot<ItemRecord>) => void>();
  const value: WorkspaceServices = {
    viewer: { uid: "user", name: "Alex", email: "alex@example.com" },
    device: { id: "00000000-0000-4000-8000-000000000010", name: "Dell Pro" },
    cloud: {
      subscribeContexts: vi.fn((emit) => {
        contextListener = emit;
        emit(contextSnapshot);
        return () => undefined;
      }),
      subscribeItems: vi.fn((contextId, emit) => {
        items.set(contextId, emit);
        emit({ records: [], fromCache: false, hasPendingWrites: false });
        return () => undefined;
      }),
      renameContext: vi.fn(async () => undefined),
      deleteContext: vi.fn(async () => undefined),
      deleteItem: vi.fn(async () => undefined),
      attachmentBytes: vi.fn(async () => new Uint8Array()),
    },
    outbox: {
      namespace: "project:user",
      enqueue: vi.fn(async () => undefined),
      count: vi.fn(async () => 0),
      clear: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    },
    drain: vi.fn(async () => undefined),
    copyText: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => true),
    signOut: vi.fn(async () => undefined),
  };
  return { value, items, emitContexts: (records: ContextRecord[], metadata = { fromCache: false, hasPendingWrites: false }) => {
    contextSnapshot = { records, ...metadata };
    contextListener?.(contextSnapshot);
  } };
}


const snap = (records = contexts) => ({ records, fromCache:false, hasPendingWrites:false });
const deferred = <T,>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r}); return {promise,resolve}; };
it("manual refresh suppresses realtime new-context auto selection", async () => {
 const t=services(); const d=deferred<CloudSnapshot<ContextRecord>>();
 t.value.cloud.refreshContexts=()=>d.promise; t.value.cloud.refreshDeletedContexts=async()=>[];
 render(createElement(ContextWorkspace, {services:t.value}));
 await userEvent.click(screen.getByRole("button",{name:"Alpha"}));
 await userEvent.click(screen.getByRole("button",{name:"Refresh"}));
 const incoming={id:"00000000-0000-4000-8000-000000000003",title:"Incoming",createdAt:30,updatedAt:30,syncState:"synced" as const,originDeviceId:"other"};
 act(()=>t.emitContexts([...contexts,incoming]));
 await act(async()=>d.resolve(snap([...contexts,incoming])));
 expect(screen.getByRole("heading",{name:"Alpha"})).toBeTruthy();
});
it("older refresh cannot overwrite a newer realtime snapshot", async()=>{
 const t=services(); const d=deferred<CloudSnapshot<ContextRecord>>();
 t.value.cloud.refreshContexts=()=>d.promise; t.value.cloud.refreshDeletedContexts=async()=>[];
 render(createElement(ContextWorkspace, {services:t.value}));
 await userEvent.click(screen.getByRole("button",{name:"Refresh"}));
 act(()=>t.emitContexts([{...contexts[0]!,title:"New title",updatedAt:50},contexts[1]!]));
 await act(async()=>d.resolve(snap()));
 expect(screen.getByRole("button",{name:"New title"})).toBeTruthy();
});
it("completed foreground catch-up must not resume a now-background app", async()=>{
 const t=services(); const d=deferred<CloudSnapshot<ContextRecord>>(); const tombstones=deferred<string[]>(); let activity!: (active:boolean)=>void;
 t.value.platformKind="android"; t.value.activity={initialActive:true,subscribe:l=>{activity=l;return ()=>{}}};
 t.value.cloud.setNetworkEnabled=async()=>{}; t.value.cloud.refreshContexts=()=>d.promise; t.value.cloud.refreshDeletedContexts=async()=>[];
 t.value.cloud.refreshDeletedContexts=()=>tombstones.promise;
 t.value.pause=vi.fn();t.value.resume=vi.fn();
 render(createElement(ContextWorkspace, {services:t.value}));
 await act(async()=>{});
 act(()=>activity(false));
 expect(t.value.pause).toHaveBeenCalled();
 await act(async()=>{d.resolve(snap());tombstones.resolve([]);});
 expect(t.value.resume).not.toHaveBeenCalled();
});
it("successful item refresh clears that stream's cache status", async()=>{
 const t=services();t.value.cloud.refreshContexts=async()=>snap(); t.value.cloud.refreshDeletedContexts=async()=>[];
 t.value.cloud.refreshItems=async()=>({records:[],fromCache:false,hasPendingWrites:false});
 render(createElement(ContextWorkspace, {services:t.value}));
 await userEvent.click(screen.getByRole("button",{name:"Alpha"}));
 act(()=>t.items.get(alpha)!({records:[],fromCache:true,hasPendingWrites:false}));
 await userEvent.click(screen.getByRole("button",{name:"Refresh"}));
 await act(async()=>{});
 expect(screen.queryAllByText("Synced").length).toBeGreaterThan(0);
});
it("one Android activation starts only one catch-up", async()=>{
 const t=services(); let reads=0;
 t.value.platformKind="android";t.value.activity={initialActive:true,subscribe:()=>()=>{}};
 t.value.cloud.setNetworkEnabled=async()=>{};
 t.value.cloud.refreshContexts=vi.fn(async()=>snap());
 t.value.cloud.refreshDeletedContexts=()=>++reads===1 ? Promise.resolve([]) : new Promise(()=>{});
 t.value.resume=vi.fn();render(createElement(ContextWorkspace,{services:t.value}));
 await act(async()=>{});
 expect(t.value.cloud.refreshContexts).toHaveBeenCalledTimes(1);
});
it("resume waits for durable tombstone removal when listener wins the read race", async()=>{
 const t=services(); const deletedRead=deferred<string[]>(); const durableDelete=deferred<void>(); let emitDeleted!: (ids:string[])=>void;
 t.value.platformKind="android"; t.value.activity={initialActive:true,subscribe:()=>()=>{}};
 t.value.cloud.setNetworkEnabled=async()=>{};t.value.cloud.refreshContexts=async()=>snap();
 t.value.cloud.refreshDeletedContexts=()=>deletedRead.promise;
 t.value.cloud.subscribeDeletedContexts=emit=>{emitDeleted=emit;return ()=>{}};
 t.value.outbox.removeContext=vi.fn(()=>durableDelete.promise);t.value.resume=vi.fn();
 render(createElement(ContextWorkspace,{services:t.value})); await act(async()=>{});
 act(()=>emitDeleted([alpha]));
 await act(async()=>deletedRead.resolve([alpha]));
 expect(t.value.outbox.removeContext).toHaveBeenCalledWith(alpha);
 expect(t.value.resume).not.toHaveBeenCalled();
 await act(async()=>durableDelete.resolve());
});
it("failed tombstone refresh cannot continue to report Synced", async()=>{
 const t=services();t.value.cloud.refreshContexts=async()=>snap();
 t.value.cloud.refreshDeletedContexts=async()=>{throw new Error("offline")};
 render(createElement(ContextWorkspace,{services:t.value}));
 await userEvent.click(screen.getByRole("button",{name:"Refresh"}));
 await act(async()=>{});
 expect(screen.getByRole("alert").textContent).toContain("could not be refreshed");
 expect(screen.queryAllByText("Synced")).toHaveLength(0);
});
it("successful reconnect resumes publishing after failed activation catch-up", async()=>{
 const t=services();let fail=true;
 t.value.platformKind="android";t.value.activity={initialActive:true,subscribe:()=>()=>{}};
 t.value.cloud.setNetworkEnabled=async()=>{};t.value.cloud.refreshContexts=async()=>snap();
 t.value.cloud.refreshDeletedContexts=async()=>{if(fail)throw new Error("offline");return []};
 t.value.resume=vi.fn();render(createElement(ContextWorkspace,{services:t.value}));await act(async()=>{});
 expect(t.value.resume).not.toHaveBeenCalled();
 fail=false;await act(async()=>window.dispatchEvent(new Event("online")));
 expect(t.value.resume).toHaveBeenCalledTimes(1);
});
it("tombstone arriving after its read settles is cleaned before final resume",async()=>{
 const t=services();const contextRead=deferred<CloudSnapshot<ContextRecord>>();const cleanup=deferred<void>();let emitDeleted!:(ids:string[])=>void;
 t.value.platformKind="android";t.value.activity={initialActive:true,subscribe:()=>()=>{}};
 t.value.cloud.setNetworkEnabled=async()=>{};t.value.cloud.refreshContexts=()=>contextRead.promise;t.value.cloud.refreshDeletedContexts=async()=>[];
 t.value.cloud.subscribeDeletedContexts=emit=>{emitDeleted=emit;return ()=>{}};
 t.value.outbox.removeContext=()=>cleanup.promise;t.value.resume=vi.fn();
 render(createElement(ContextWorkspace,{services:t.value}));await act(async()=>{});
 act(()=>emitDeleted([alpha]));await act(async()=>contextRead.resolve(snap()));
 expect(t.value.resume).not.toHaveBeenCalled();await act(async()=>cleanup.resolve());
});
it("manual recovery waits for cleanups added while the first cleanup is pending", async () => {
 const t=services(); let fail=true; let emitDeleted!: (ids:string[])=>void;
 const first=deferred<void>(); const second=deferred<void>();
 t.value.platformKind="android"; t.value.activity={initialActive:true,subscribe:()=>()=>{}};
 t.value.cloud.setNetworkEnabled=async()=>{}; t.value.cloud.refreshContexts=async()=>snap();
 t.value.cloud.refreshDeletedContexts=async()=>{if(fail)throw new Error("offline");return []};
 t.value.cloud.subscribeDeletedContexts=emit=>{emitDeleted=emit;return ()=>{}};
 t.value.outbox.removeContext=id=>id===alpha?first.promise:second.promise;
 t.value.resume=vi.fn();render(createElement(ContextWorkspace,{services:t.value}));await act(async()=>{});
 act(()=>emitDeleted([alpha])); fail=false;
 await userEvent.click(screen.getByRole("button",{name:"Refresh"}));
 act(()=>emitDeleted([alpha,beta])); await act(async()=>first.resolve());
 expect(t.value.resume).not.toHaveBeenCalled();
 await act(async()=>second.resolve());expect(t.value.resume).toHaveBeenCalledTimes(1);
 expect(t.value.outbox.retry).not.toHaveBeenCalled();
});
it("backgrounding while durable cleanup is pending cancels publishing recovery", async () => {
 const t=services();const removal=deferred<void>();let activity!:(active:boolean)=>void;
 t.value.platformKind="android";t.value.activity={initialActive:true,subscribe:listener=>{activity=listener;return ()=>{}}};
 t.value.cloud.setNetworkEnabled=async()=>{};t.value.cloud.refreshContexts=async()=>snap();t.value.cloud.refreshDeletedContexts=async()=>[alpha];
 t.value.outbox.removeContext=()=>removal.promise;t.value.resume=vi.fn();t.value.pause=vi.fn();
 render(createElement(ContextWorkspace,{services:t.value}));await act(async()=>{});
 act(()=>activity(false));await act(async()=>removal.resolve());expect(t.value.resume).not.toHaveBeenCalled();
});

it("merged per-item tombstones wait for durable cleanup before Android publishing recovers", async () => {
 const t=services(); const removal=deferred<void>(); const itemId="00000000-0000-4000-8000-000000000003";
 t.value.platformKind="android"; t.value.activity={initialActive:true,subscribe:()=>()=>{}};
 t.value.cloud.refreshContexts=async()=>snap(); t.value.cloud.refreshDeletedContexts=async()=>[];
 const refreshDeletedItems=vi.fn(async()=>[{contextId:alpha,itemId}]);
 Object.assign(t.value.cloud,{refreshDeletedItems});
 t.value.outbox.removeItem=vi.fn(()=>removal.promise); t.value.resume=vi.fn();
 render(createElement(ContextWorkspace,{services:t.value})); await act(async()=>{});
 expect(refreshDeletedItems).toHaveBeenCalledTimes(1);
 expect(t.value.outbox.removeItem).toHaveBeenCalledWith(alpha,itemId);
 expect(t.value.resume).not.toHaveBeenCalled();
 await act(async()=>removal.resolve()); expect(t.value.resume).toHaveBeenCalledTimes(1);
});

it("merged item deletion listener joins cleanup barrier and stops while Android is backgrounded", async () => {
 const t=services(); const read=deferred<CloudSnapshot<ContextRecord>>(); const removal=deferred<void>();
 const itemId="00000000-0000-4000-8000-000000000003"; let emit!:(items:{contextId:string;itemId:string}[])=>void; let activity!:(active:boolean)=>void;
 const unsubscribe=vi.fn(); t.value.cloud.subscribeDeletedItems=listener=>{emit=listener;return unsubscribe;};
 t.value.platformKind="android";t.value.activity={initialActive:true,subscribe:listener=>{activity=listener;return ()=>{};}};
 t.value.cloud.refreshContexts=()=>read.promise;t.value.cloud.refreshDeletedContexts=async()=>[];
 Object.assign(t.value.cloud,{refreshDeletedItems:async()=>[]});
 t.value.outbox.removeItem=vi.fn(()=>removal.promise);t.value.resume=vi.fn();
 render(createElement(ContextWorkspace,{services:t.value})); await act(async()=>{});
 act(()=>emit([{contextId:alpha,itemId}]));await act(async()=>read.resolve(snap()));
 expect(t.value.resume).not.toHaveBeenCalled();
 act(()=>activity(false)); expect(unsubscribe).toHaveBeenCalledTimes(1);
 await act(async()=>removal.resolve()); expect(t.value.resume).not.toHaveBeenCalled();
});

it("a failed merged item tombstone refresh blocks publishing and the Synced label", async () => {
 const t=services();t.value.platformKind="android";t.value.activity={initialActive:true,subscribe:()=>()=>{}};
 t.value.cloud.refreshContexts=async()=>snap();t.value.cloud.refreshDeletedContexts=async()=>[];
 Object.assign(t.value.cloud,{refreshDeletedItems:async()=>{throw new Error("offline");}});t.value.resume=vi.fn();
 render(createElement(ContextWorkspace,{services:t.value}));await act(async()=>{});
 expect(t.value.resume).not.toHaveBeenCalled();expect(screen.queryAllByText("Synced")).toHaveLength(0);
});
