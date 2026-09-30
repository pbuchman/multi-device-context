import { describe, expect, it, vi } from "vitest";

import { cloudFailure, publishQueuedShare, type CloudWritePort } from "./cloud.js";
import type { QueuedShare } from "./outbox.js";

const textRecord: QueuedShare = {
  key: "key",
  namespace: "project:user",
  contextId: "00000000-0000-4000-8000-000000000001",
  itemId: "00000000-0000-4000-8000-000000000002",
  title: "Title",
  content: { kind: "text", text: "  exact\n" },
  device: { id: "00000000-0000-4000-8000-000000000010", name: "Device" },
  createsContext: true,
  attempts: 0,
  queuedAt: 0,
  nextAttemptAt: 0,
  status: "pending",
};

function port(overrides: Partial<CloudWritePort> = {}): CloudWritePort {
  return {
    findContext: vi.fn(async () => undefined),
    findItem: vi.fn(async () => undefined),
    createInitial: vi.fn(async () => undefined),
    append: vi.fn(async () => undefined),
    completeAttachment: vi.fn(async () => "complete" as const),
    upload: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("cloud publishing", () => {
  it("pauses authentication and quota failures while retrying transient service faults", () => {
    expect(cloudFailure({ code: "unauthenticated" })).toMatchObject({ retryable: false });
    expect(cloudFailure({ code: "storage/quota-exceeded" })).toMatchObject({ retryable: false });
    expect(cloudFailure({ code: "unavailable" })).toMatchObject({ retryable: true });
  });
  it("reuses an equal immutable item after an uncertain commit without rewriting timestamps", async () => {
    const adapter = port({
      findContext: vi.fn(async () => ({ id: textRecord.contextId })),
      findItem: vi.fn(async () => ({ content: textRecord.content, device: textRecord.device, ready: true })),
    });
    await publishQueuedShare(textRecord, adapter);
    expect(adapter.createInitial).not.toHaveBeenCalled();
    expect(adapter.append).not.toHaveBeenCalled();
  });

  it("recovers an upload completed before a crash by calling completion before uploading", async () => {
    const adapter = port({
      findContext: vi.fn(async () => ({ id: textRecord.contextId })),
      findItem: vi.fn(async () => ({
        content: { kind: "attachment" as const, name: "x.bin", contentType: "application/octet-stream", size: 3 },
        device: textRecord.device,
        ready: false,
      })),
      completeAttachment: vi.fn(async () => "complete" as const),
    });
    const record = {
      ...textRecord,
      content: { kind: "attachment", name: "x.bin", contentType: "application/octet-stream", size: 3 } as const,
      bytes: new Uint8Array([1, 2, 3]),
    };
    await publishQueuedShare(record, adapter);
    expect(adapter.completeAttachment).toHaveBeenCalledTimes(1);
    expect(adapter.upload).not.toHaveBeenCalled();
  });

  it("uploads exact bytes only after a missing completion, then finalizes", async () => {
    const adapter = port({
      completeAttachment: vi.fn()
        .mockResolvedValueOnce("missing")
        .mockResolvedValueOnce("complete"),
    });
    const bytes = new Uint8Array([0, 255, 3]);
    const record = {
      ...textRecord,
      content: { kind: "attachment", name: "x.bin", contentType: "application/octet-stream", size: 3 } as const,
      bytes,
    };
    await publishQueuedShare(record, adapter);
    expect(adapter.createInitial).toHaveBeenCalledWith(record);
    expect(adapter.findItem).not.toHaveBeenCalled();
    expect(adapter.upload).toHaveBeenCalledWith(record, bytes);
    expect(adapter.completeAttachment).toHaveBeenCalledTimes(2);
  });

  it("never recreates a missing context for an append", async () => {
    const adapter = port();
    await expect(publishQueuedShare({ ...textRecord, createsContext: false }, adapter))
      .rejects.toMatchObject({ retryable: false });
    expect(adapter.createInitial).not.toHaveBeenCalled();
    expect(adapter.append).not.toHaveBeenCalled();
  });

});
