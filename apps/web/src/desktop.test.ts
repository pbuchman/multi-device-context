import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@mdc/contracts";

import { drainNativeClipboardQueue } from "./desktop.js";

describe("native clipboard queue", () => {
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
