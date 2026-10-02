import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge, PendingClipboardShare } from "@mdc/contracts";

import { drainNativeClipboardQueue } from "./desktop.js";

describe("native clipboard queue", () => {
  it("does not import an inbox result after its account was disposed", async () => {
    let current=true;let resolve!:(requests:PendingClipboardShare[])=>void;
    const bridge={getPendingClipboardShares:()=>new Promise<PendingClipboardShare[]>(done=>{resolve=done;}),acknowledgeClipboardShare:vi.fn(async()=>{})};
    const store={hasNativeRequest:vi.fn(async()=>false),storeNativeSnapshot:vi.fn(async()=>{}),markNativeAcknowledged:vi.fn(async()=>{})};
    const pending=drainNativeClipboardQueue(bridge,store,()=>current);
    current=false;resolve([{id:"00000000-0000-4000-8000-000000000001",capturedAt:1,snapshot:{text:"pending",files:[]}}]);await pending;
    expect(store.storeNativeSnapshot).not.toHaveBeenCalled();expect(bridge.acknowledgeClipboardShare).not.toHaveBeenCalled();
  });
  it("leaves the native share unacknowledged when disposed during its durable write", async () => {
    let current=true;let resolve!:()=>void;
    const request={id:"00000000-0000-4000-8000-000000000001",capturedAt:1,snapshot:{text:"pending",files:[]}};
    const bridge={getPendingClipboardShares:async()=>[request],acknowledgeClipboardShare:vi.fn(async()=>{})};
    const store={hasNativeRequest:async()=>false,storeNativeSnapshot:vi.fn(()=>new Promise<void>(done=>{resolve=done;})),markNativeAcknowledged:vi.fn(async()=>{})};
    const pending=drainNativeClipboardQueue(bridge,store,()=>current);
    await vi.waitFor(()=>expect(store.storeNativeSnapshot).toHaveBeenCalledTimes(1));current=false;resolve();await pending;
    expect(bridge.acknowledgeClipboardShare).not.toHaveBeenCalled();expect(store.markNativeAcknowledged).not.toHaveBeenCalled();
  });
  it("stores the snapshot before acknowledging and retries a failed acknowledgement without duplication", async () => {
    const events: string[] = [];
    const request = {
      id: "00000000-0000-4000-8000-000000000001",
      capturedAt: 10,
      snapshot: { text: "clipboard", files: [] },
    } as const;
    const bridge = {
      getPendingClipboardShares: vi.fn(async () => [request]),
      acknowledgeClipboardShare: vi.fn()
        .mockImplementationOnce(async () => { events.push("ack"); throw new Error("ipc failed"); })
        .mockImplementationOnce(async () => { events.push("ack"); }),
    } as unknown as DesktopBridge;
    const store = {
      hasNativeRequest: vi.fn(async () => false),
      storeNativeSnapshot: vi.fn(async () => { events.push("store"); }),
      markNativeAcknowledged: vi.fn(async () => { events.push("marked"); }),
    };

    await expect(drainNativeClipboardQueue(bridge, store)).rejects.toThrow("ipc failed");
    store.hasNativeRequest.mockResolvedValue(true);
    await drainNativeClipboardQueue(bridge, store);

    expect(events).toEqual(["store", "ack", "ack", "marked"]);
    expect(store.storeNativeSnapshot).toHaveBeenCalledTimes(1);
  });
});
