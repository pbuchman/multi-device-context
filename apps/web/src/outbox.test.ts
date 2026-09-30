import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { DurableOutbox, OutboxRunner, type PublishPort } from "./outbox.js";

const namespaceA = { projectId: "project-a", uid: "user-a" };
const namespaceB = { projectId: "project-a", uid: "user-b" };
const device = { id: "00000000-0000-4000-8000-000000000010", name: "Dell Pro" } as const;
const contextId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";

function draft(overrides = {}) {
  return {
    contextId,
    itemId,
    title: "Exact whitespace",
    content: { kind: "text", text: "  exact\n" } as const,
    device,
    createsContext: true,
    ...overrides,
  };
}

describe("DurableOutbox", () => {
  beforeEach(async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  });

  it("does not restore pending content when deletion races an in-flight failure", async () => {
    const outbox = new DurableOutbox(namespaceA);
    await outbox.enqueue(draft());
    const record = (await outbox.list())[0]!;
    await outbox.removeContext(contextId);
    await outbox.markFailed(record, new Error("late network failure"), 1000, false);
    await outbox.retry();
    expect(await outbox.list()).toEqual([]);
    await expect(outbox.enqueue(draft())).rejects.toThrow("deleted");
    expect(await outbox.enqueueNativeRequest(contextId, [draft({ nativeRequestId: contextId })])).toBe(true);
    expect(await outbox.list()).toEqual([]);
    outbox.close();
  });

  it("retains stable IDs, exact content and attachment bytes across reopen", async () => {
    const first = new DurableOutbox(namespaceA);
    await first.enqueue(draft({
      content: { kind: "attachment", name: "notes.txt", contentType: "text/plain", size: 4 },
      bytes: new Uint8Array([0, 1, 2, 255]),
    }));
    first.close();

    const reopened = new DurableOutbox(namespaceA);
    const [queued] = await reopened.list();
    expect(queued).toMatchObject({ contextId, itemId, title: "Exact whitespace" });
    expect([...queued!.bytes!]).toEqual([0, 1, 2, 255]);
    reopened.close();
  });

  it("isolates accounts and clears only the signed-out namespace", async () => {
    const a = new DurableOutbox(namespaceA);
    const b = new DurableOutbox(namespaceB);
    await a.enqueue(draft());
    await b.enqueue(draft({ itemId: "00000000-0000-4000-8000-000000000003" }));

    expect(await a.count()).toBe(1);
    expect(await b.count()).toBe(1);
    a.close();
    b.close();
    await a.clear();
    expect(await a.count()).toBe(0);
    expect(await b.count()).toBe(1);
  });

  it("retries with immutable IDs and survives a crash between attempts", async () => {
    const outbox = new DurableOutbox(namespaceA);
    await outbox.enqueue(draft());
    const publish = vi.fn<PublishPort["publish"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);

    const firstRunner = new OutboxRunner(outbox, { publish }, { baseDelayMs: 0 });
    await firstRunner.drain();
    firstRunner.stop();
    outbox.close();
    const reopened = new DurableOutbox(namespaceA);
    await new OutboxRunner(reopened, { publish }, { baseDelayMs: 0 }).drain();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]![0]).toMatchObject({ contextId, itemId });
    expect(publish.mock.calls[1]![0]).toMatchObject({ contextId, itemId });
    expect(await reopened.count()).toBe(0);
    reopened.close();
  });

  it("deduplicates a replayed native request until acknowledgement succeeds", async () => {
    const outbox = new DurableOutbox(namespaceA);
    const requestId = contextId;
    const stored = await outbox.enqueueNativeRequest(requestId, [draft({ nativeRequestId: requestId })]);
    expect(stored).toBe(true);
    expect(await outbox.enqueueNativeRequest(requestId, [draft({ nativeRequestId: requestId })])).toBe(false);

    await new OutboxRunner(outbox, { publish: vi.fn(async () => undefined) }, { baseDelayMs: 0 }).drain();
    expect(await outbox.count()).toBe(0);
    expect(await outbox.hasNativeRequest(requestId)).toBe(true);
    expect(await outbox.enqueueNativeRequest(requestId, [draft({ nativeRequestId: requestId })])).toBe(false);

    await outbox.markNativeAcknowledged(requestId);
    expect(await outbox.hasNativeRequest(requestId)).toBe(false);
    outbox.close();
  });

  it("publishes a context-creating item before later items regardless of UUID ordering", async () => {
    const outbox = new DurableOutbox(namespaceA);
    const later = draft({ itemId: "00000000-0000-4000-8000-000000000001", createsContext: false });
    const creator = draft({ itemId: "ffffffff-ffff-4fff-8fff-ffffffffffff", createsContext: true });
    await outbox.enqueue(later);
    await outbox.enqueue(creator);
    const order: string[] = [];
    await new OutboxRunner(outbox, { publish: vi.fn(async (record) => { order.push(record.itemId); }) }).drain();
    expect(order).toEqual([creator.itemId, later.itemId]);
    outbox.close();
  });

  it("automatically retries transient failures with bounded scheduling", async () => {
    const outbox = new DurableOutbox(namespaceA);
    await outbox.enqueue(draft());
    const publish = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const runner = new OutboxRunner(outbox, { publish }, { baseDelayMs: 1, maxDelayMs: 1 });
    await runner.drain();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    runner.stop();
    outbox.close();
  });

  it("blocks child items while their context creator is waiting to retry", async () => {
    const outbox = new DurableOutbox(namespaceA);
    const creator = draft({ itemId: "ffffffff-ffff-4fff-8fff-ffffffffffff", createsContext: true });
    const child = draft({ itemId: "00000000-0000-4000-8000-000000000001", createsContext: false });
    await outbox.enqueue(creator);
    await outbox.enqueue(child);
    const publish = vi.fn(async (record) => {
      if (record.createsContext) throw new Error("offline");
    });
    const runner = new OutboxRunner(outbox, { publish }, { baseDelayMs: 60_000 });
    await runner.drain();
    await runner.drain();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0].itemId).toBe(creator.itemId);
    runner.stop();
    outbox.close();
  });

  it("does not recreate cleared rows when stopped during an in-flight failure", async () => {
    const outbox = new DurableOutbox(namespaceA);
    await outbox.enqueue(draft());
    let rejectPublish!: (error: Error) => void;
    const publish = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPublish = reject; }));
    const runner = new OutboxRunner(outbox, { publish });
    const draining = runner.drain();
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    runner.stop();
    await outbox.clear();
    rejectPublish(new Error("late failure"));
    await draining;
    expect(await outbox.count()).toBe(0);
    outbox.close();
  });

  it("reconstructs a future retry timer after restart", async () => {
    const outbox = new DurableOutbox(namespaceA);
    await outbox.enqueue(draft());
    const firstRunner = new OutboxRunner(outbox, { publish: vi.fn(async () => { throw new Error("offline"); }) }, { baseDelayMs: 20, maxDelayMs: 20 });
    await firstRunner.drain();
    firstRunner.stop();
    outbox.close();

    const reopened = new DurableOutbox(namespaceA);
    const publish = vi.fn(async () => undefined);
    const resumed = new OutboxRunner(reopened, { publish }, { baseDelayMs: 20, maxDelayMs: 20 });
    await resumed.drain();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(await reopened.count()).toBe(0);
    resumed.stop();
    reopened.close();
  });

  it("drains work enqueued while another publish is in flight", async () => {
    const outbox = new DurableOutbox(namespaceA);
    await outbox.enqueue(draft());
    let release!: () => void;
    const publish = vi.fn((record) => record.itemId === itemId
      ? new Promise<void>((resolve) => { release = resolve; })
      : Promise.resolve());
    const runner = new OutboxRunner(outbox, { publish });
    const draining = runner.drain();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await outbox.enqueue(draft({
      contextId: "00000000-0000-4000-8000-000000000004",
      itemId: "00000000-0000-4000-8000-000000000005",
    }));
    await runner.drain();
    release();
    await draining;
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(await outbox.count()).toBe(0);
    runner.stop();
    outbox.close();
  });
});

it("R6: a multi-file queue transaction cannot partially commit before a rejected item", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  const outbox = new DurableOutbox(namespaceA);
  const secondId = "00000000-0000-4000-8000-000000000003";
  await outbox.removeItem(contextId, secondId);
  await expect(outbox.enqueueBatch([draft(), draft({ itemId: secondId })])).rejects.toThrow("deleted");
  expect(await outbox.list()).toEqual([]); outbox.close();
});
