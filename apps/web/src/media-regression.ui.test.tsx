// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import type { CloudSnapshot } from "./cloud.js";
import type { ContextRecord, ItemRecord } from "./model.js";

const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
const contexts: ContextRecord[] = [
  { id: alpha, title: "Alpha", createdAt: 1, updatedAt: 20, syncState: "synced" },
  { id: beta, title: "Beta", createdAt: 2, updatedAt: 10, syncState: "synced" },
];

afterEach(() => { cleanup(); localStorage.clear(); history.replaceState({}, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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


it("R6: identical snapshots reuse the attachment preview", async()=>{
 vi.stubGlobal("URL",Object.assign(URL,{createObjectURL:vi.fn(()=>"blob:review"),revokeObjectURL:vi.fn()}));
 const test=services();render(<ContextWorkspace services={test.value}/>);
 await userEvent.click(screen.getByRole("button",{name:"Alpha"}));
 const picture:ItemRecord={id:"00000000-0000-4000-8000-000000000077",contextId:alpha,content:{kind:"attachment",name:"pic.png",contentType:"image/png",size:1},device:test.value.device,createdAt:1,ready:true,syncState:"synced"};
 act(()=>test.items.get(alpha)!({records:[picture],fromCache:false,hasPendingWrites:false}));
 await waitFor(()=>expect(test.value.cloud.attachmentBytes).toHaveBeenCalledTimes(1));
 act(()=>test.items.get(alpha)!({records:[{...picture,content:{...picture.content}}],fromCache:false,hasPendingWrites:false}));
 await waitFor(()=>expect(test.value.cloud.attachmentBytes).toHaveBeenCalledTimes(1));
 vi.unstubAllGlobals();
});

it("does not copy an image when access changes during image decoding", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:review"), revokeObjectURL: vi.fn() }));
  let release!: (bitmap: ImageBitmap) => void;
  vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>(resolve => { release = resolve; })));
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    if (tagName !== "canvas") return originalCreateElement(tagName, options);
    return {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
    } as unknown as HTMLCanvasElement;
  });
  const test = services(); let accessActive = true; test.value.accessActive = () => accessActive;
  test.value.cloud.attachmentBytes = vi.fn(async () => new Uint8Array([255, 216, 255, 217]));
  render(<ContextWorkspace services={test.value} />);
  await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
  const picture: ItemRecord = { id: "00000000-0000-4000-8000-000000000078", contextId: alpha, content: { kind: "attachment", name: "photo.jpg", contentType: "image/jpeg", size: 4 }, device: test.value.device, createdAt: 1, ready: true, syncState: "synced" };
  act(() => test.items.get(alpha)!({ records: [picture], fromCache: false, hasPendingWrites: false }));
  await userEvent.click(await screen.findByRole("button", { name: "Copy photo.jpg" }));
  await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));

  accessActive = false;
  release({ width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap);

  await act(async () => undefined);
  expect(test.value.copyFile).not.toHaveBeenCalled();
});
