// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import { DurableOutbox } from "./outbox.js";
import type { DictationBridge, DictationStatus } from "./dictation.js";
const alpha="00000000-0000-4000-8000-000000000001",session="00000000-0000-4000-8000-000000000003";
afterEach(()=>{cleanup();localStorage.clear();history.replaceState({},"","/");});
it.each([false,true])("connects native completion to the real workspace and durable outbox, existing chat=%s",async existing=>{
 if(existing)history.replaceState({},"",`/contexts/${alpha}`);
 let state:DictationStatus={phase:"none"};
 const bridge:DictationBridge={authorize:async()=>{},subscribeRevoked:()=>()=>{},read:async()=>state,report:vi.fn(async value=>{state={id:value.id,phase:value.phase};})};
 const outbox=new DurableOutbox({projectId:"workspace-dictation",uid:crypto.randomUUID()});
 const record=existing?[{id:alpha,title:"Existing",createdAt:1,updatedAt:1,syncState:"synced" as const}]:[];
 const services:WorkspaceServices={platformKind:"android",dictation:bridge,viewer:{uid:"fixture",name:"Synthetic"},device:{id:alpha,name:"Synthetic Android"},
  cloud:{subscribeContexts:emit=>{emit({records:record,fromCache:false,hasPendingWrites:false});return()=>{};},subscribeItems:()=>()=>{},renameContext:async()=>{},deleteContext:async()=>{},deleteItem:async()=>{},attachmentBytes:async()=>new Uint8Array()},
  outbox,drain:async()=>{},copyText:async()=>{},copyFile:async()=>{},saveFile:async()=>true,signOut:async()=>{}};
 render(<ContextWorkspace services={services}/>);
 const field=await screen.findByRole("textbox",{name:"Message to yourself"}) as HTMLTextAreaElement;
 await act(async()=>{field.focus();});
 const prior=existing?"alpha beta":"";if(existing)fireEvent.change(field,{target:{value:prior}});
 await waitFor(()=>expect(field.value).toBe(prior));
 // Let the existing draft persistence settle before capturing its revision.
 await new Promise(resolve=>setTimeout(resolve,200));
 act(()=>field.setSelectionRange(existing?6:0,existing?10:0));
 state={id:session,phase:"begin"};
 await waitFor(()=>expect(bridge.report).toHaveBeenCalledWith(expect.objectContaining({phase:"prepared"})),{timeout:2000});
 state={id:session,phase:"recording"};await new Promise(resolve=>setTimeout(resolve,200));
 state={id:session,phase:"processing"};await new Promise(resolve=>setTimeout(resolve,200));
 const expected=existing?"alpha words":"words";
 fireEvent.change(field,{target:{value:expected}});act(()=>field.setSelectionRange(expected.length,expected.length));state={id:session,phase:"complete"};
 await waitFor(()=>expect(bridge.report).toHaveBeenCalledWith(expect.objectContaining({phase:"queued"})),{timeout:3000});
 const queued=await outbox.list();expect(queued).toHaveLength(1);expect(queued[0]!.content).toEqual({kind:"text",text:expected});
 if(existing)expect(queued[0]!.contextId).toBe(alpha);expect(field.value).toBe("");
 state={id:session,phase:"complete"};await new Promise(resolve=>setTimeout(resolve,300));expect(await outbox.count()).toBe(1);outbox.close();
});
