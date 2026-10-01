// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DraftStore } from "./drafts.js";
import { ContextWorkspace, sharePartsFromSnapshot, type WorkspaceServices } from "./App.js";
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
      namespace: `project:user:${crypto.randomUUID()}`,
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

describe("ContextWorkspace", () => {
  it("preserves Android shared text and files in one incoming snapshot", () => {
    const parts = sharePartsFromSnapshot({
      text: "caption",
      files: [{ name: "photo.jpg", contentType: "image/jpeg", bytes: new Uint8Array([1, 2]) }],
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]?.content).toEqual({ kind: "text", text: "caption" });
    expect(parts[1]?.content).toEqual({ kind: "attachment", name: "photo.jpg", contentType: "image/jpeg", size: 2 });
  });
  it("refreshes server contexts, tombstones, and selected items without changing selection or draft", async () => {
    const test = services();
    test.value.cloud.refreshContexts = vi.fn(async () => ({ records: contexts, fromCache: false, hasPendingWrites: false }));
    test.value.cloud.refreshDeletedContexts = vi.fn(async () => []);
    test.value.cloud.refreshItems = vi.fn(async () => ({ records: [], fromCache: false, hasPendingWrites: false }));
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await userEvent.type(screen.getByLabelText("Message to yourself"), "keep me");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(test.value.cloud.refreshItems).toHaveBeenCalledWith(alpha));
    expect(test.value.cloud.refreshContexts).toHaveBeenCalledTimes(1);
    expect(test.value.cloud.refreshDeletedContexts).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect((screen.getByLabelText("Message to yourself") as HTMLTextAreaElement).value).toBe("keep me");
  });

  it("invokes refresh methods with their cloud receiver", async () => {
    const test = services();
    const cloud = test.value.cloud as WorkspaceServices["cloud"] & { receiverToken?: string };
    cloud.receiverToken = "cloud";
    cloud.refreshContexts = vi.fn(async function (this: typeof cloud) {
      if (this.receiverToken !== "cloud") throw new Error("missing cloud receiver");
      return { records: contexts, fromCache: false, hasPendingWrites: false };
    });
    cloud.refreshDeletedContexts = vi.fn(async function (this: typeof cloud) {
      if (this.receiverToken !== "cloud") throw new Error("missing cloud receiver");
      return [];
    });
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(cloud.refreshContexts).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps selection and newer realtime contexts when an older manual refresh finishes late", async () => {
    const test = services();
    let finish!: (snapshot: CloudSnapshot<ContextRecord>) => void;
    test.value.cloud.refreshContexts = vi.fn(() => new Promise<CloudSnapshot<ContextRecord>>(resolve => { finish = resolve; }));
    test.value.cloud.refreshDeletedContexts = vi.fn(async () => []);
    test.value.cloud.refreshItems = vi.fn(async () => ({ records: [], fromCache: false, hasPendingWrites: false }));
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    act(() => test.emitContexts([
      { ...contexts[0]!, title: "Realtime Alpha", updatedAt: 200 },
      { id: "00000000-0000-4000-8000-000000000003", title: "Incoming", createdAt: 100, updatedAt: 100, syncState: "synced" },
    ]));
    expect(screen.getByRole("heading", { name: "Realtime Alpha" })).toBeTruthy();
    await act(async () => finish({ records: contexts, fromCache: false, hasPendingWrites: false }));
    expect(screen.getByRole("heading", { name: "Realtime Alpha" })).toBeTruthy();
  });

  it("uses successful item refresh metadata instead of retaining cached item status", async () => {
    const test = services();
    test.value.cloud.refreshContexts = vi.fn(async () => ({ records: contexts, fromCache: false, hasPendingWrites: false }));
    test.value.cloud.refreshDeletedContexts = vi.fn(async () => []);
    test.value.cloud.refreshItems = vi.fn(async () => ({ records: [], fromCache: false, hasPendingWrites: false }));
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    act(() => test.items.get(alpha)!({ records: [], fromCache: true, hasPendingWrites: false }));
    expect(screen.getAllByText("Offline history").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getAllByText("Synced").length).toBeGreaterThan(0));
  });

  it("does not overwrite newer realtime items with an older explicit read", async () => {
    const test = services();
    let finish!: (snapshot: CloudSnapshot<ItemRecord>) => void;
    test.value.cloud.refreshContexts = vi.fn(async () => ({ records: contexts, fromCache: false, hasPendingWrites: false }));
    test.value.cloud.refreshDeletedContexts = vi.fn(async () => []);
    test.value.cloud.refreshItems = vi.fn(() => new Promise<CloudSnapshot<ItemRecord>>(resolve => { finish = resolve; }));
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    act(() => test.items.get(alpha)!({
      records: [{ id: beta, contextId: alpha, content: { kind: "text", text: "new realtime item" }, device: test.value.device, createdAt: 50, ready: true, syncState: "synced" }],
      fromCache: false,
      hasPendingWrites: false,
    }));
    await act(async () => finish({ records: [], fromCache: false, hasPendingWrites: false }));
    expect(screen.getByText("new realtime item")).toBeTruthy();
  });

  it("does not resume after an in-flight foreground catch-up is backgrounded", async () => {
    const test = services();
    let activity!: (active: boolean) => void;
    let finishContexts!: (snapshot: CloudSnapshot<ContextRecord>) => void;
    let finishDeleted!: (ids: string[]) => void;
    test.value.platformKind = "android";
    test.value.activity = { initialActive: true, subscribe: listener => { activity = listener; return () => undefined; } };
    test.value.cloud.setNetworkEnabled = vi.fn(async () => undefined);
    test.value.cloud.refreshContexts = vi.fn(() => new Promise<CloudSnapshot<ContextRecord>>(resolve => { finishContexts = resolve; }));
    test.value.cloud.refreshDeletedContexts = vi.fn(() => new Promise<string[]>(resolve => { finishDeleted = resolve; }));
    test.value.pause = vi.fn();
    test.value.resume = vi.fn();
    render(<ContextWorkspace services={test.value} />);
    await act(async () => undefined);
    act(() => activity(false));
    expect(test.value.pause).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishContexts({ records: contexts, fromCache: false, hasPendingWrites: false });
      finishDeleted([]);
    });
    expect(test.value.resume).not.toHaveBeenCalled();
  });

  it("starts one catch-up for one Android activation", async () => {
    const test = services();
    test.value.platformKind = "android";
    test.value.activity = { initialActive: true, subscribe: () => () => undefined };
    test.value.cloud.setNetworkEnabled = vi.fn(async () => undefined);
    test.value.cloud.refreshContexts = vi.fn(async () => ({ records: contexts, fromCache: false, hasPendingWrites: false }));
    test.value.cloud.refreshDeletedContexts = vi.fn(async () => []);
    test.value.resume = vi.fn();
    render(<ContextWorkspace services={test.value} />);
    await waitFor(() => expect(test.value.resume).toHaveBeenCalledTimes(1));
    expect(test.value.cloud.refreshContexts).toHaveBeenCalledTimes(1);
    expect(test.value.cloud.refreshDeletedContexts).toHaveBeenCalledTimes(1);
  });

  it("durably removes catch-up tombstones before resuming publishing", async () => {
    const test = services();
    let finishRemoval!: () => void;
    test.value.platformKind = "android";
    test.value.activity = { initialActive: true, subscribe: () => () => undefined };
    test.value.cloud.setNetworkEnabled = vi.fn(async () => undefined);
    test.value.cloud.refreshContexts = vi.fn(async () => ({ records: contexts, fromCache: false, hasPendingWrites: false }));
    test.value.cloud.refreshDeletedContexts = vi.fn(async () => [alpha]);
    test.value.outbox.removeContext = vi.fn(() => new Promise<void>(resolve => { finishRemoval = resolve; }));
    test.value.resume = vi.fn();
    render(<ContextWorkspace services={test.value} />);
    await waitFor(() => expect(test.value.outbox.removeContext).toHaveBeenCalledWith(alpha));
    expect(test.value.resume).not.toHaveBeenCalled();
    await act(async () => finishRemoval());
    await waitFor(() => expect(test.value.resume).toHaveBeenCalledTimes(1));
  });

  it("waits for realtime tombstone cleanup before catch-up resumes", async () => {
    const test = services();
    let emitDeleted!: (ids: string[]) => void;
    let finishRead!: (ids: string[]) => void;
    let finishRemoval!: () => void;
    test.value.platformKind = "android";
    test.value.activity = { initialActive: true, subscribe: () => () => undefined };
    test.value.cloud.setNetworkEnabled = vi.fn(async () => undefined);
    test.value.cloud.refreshContexts = vi.fn(async () => ({ records: contexts, fromCache: false, hasPendingWrites: false }));
    test.value.cloud.refreshDeletedContexts = vi.fn(() => new Promise<string[]>(resolve => { finishRead = resolve; }));
    test.value.cloud.subscribeDeletedContexts = vi.fn((emit) => { emitDeleted = emit; return () => undefined; });
    test.value.outbox.removeContext = vi.fn(() => new Promise<void>(resolve => { finishRemoval = resolve; }));
    test.value.resume = vi.fn();
    render(<ContextWorkspace services={test.value} />);
    await act(async () => undefined);
    act(() => emitDeleted([alpha]));
    await act(async () => finishRead([alpha]));
    expect(test.value.resume).not.toHaveBeenCalled();
    await act(async () => finishRemoval());
    await waitFor(() => expect(test.value.resume).toHaveBeenCalledTimes(1));
  });

  it("does not report Synced while tombstone refresh is failed", async () => {
    const test = services();
    test.value.cloud.refreshContexts = vi.fn(async () => ({ records: contexts, fromCache: false, hasPendingWrites: false }));
    test.value.cloud.refreshDeletedContexts = vi.fn(async () => { throw new Error("offline"); });
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be refreshed"));
    expect(screen.queryAllByText("Synced")).toHaveLength(0);
  });

  it("shows explicit Android paste, send, settings, and attachment share controls", async () => {
    const test = services();
    test.value.platformKind = "android";
    test.value.readClipboard = vi.fn(async () => ({ text: "native paste", files: [] }));
    test.value.shareFile = vi.fn(async () => true);
    render(<ContextWorkspace services={test.value} />);
    expect(screen.getByRole("button", { name: "Paste and send" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeTruthy();
    expect(screen.queryByText("Launch at login")).toBeNull();
    expect(screen.getByText("Chat with yourself · Your devices")).toBeTruthy();
    expect(screen.queryByText(/press Enter/)).toBeNull();
  });

  it("waits for a new context to be acknowledged before reading its items", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.paste(screen.getByLabelText("Message to yourself"), {
      clipboardData: { files: [], getData: () => "first share" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(test.value.drain).toHaveBeenCalled());
    const draft = vi.mocked(test.value.outbox.enqueue).mock.calls[0]![0];
    expect(draft.createsContext).toBe(true);
    expect(within(screen.getByLabelText("Messages to yourself")).getByText("first share")).toBeTruthy();
    expect(test.items.has(draft.contextId)).toBe(false);

    const pending: ContextRecord = { id: draft.contextId, title: draft.title, createdAt: 30, updatedAt: 30, syncState: "pending" };
    act(() => test.emitContexts([pending, ...contexts], { fromCache: true, hasPendingWrites: true }));
    expect(test.items.has(draft.contextId)).toBe(false);

    act(() => test.emitContexts([{ ...pending, syncState: "synced" }, ...contexts]));
    await waitFor(() => expect(test.items.has(draft.contextId)).toBe(true));
    act(() => test.items.get(draft.contextId)!({
      records: [{ id: draft.itemId, contextId: draft.contextId, content: draft.content, device: draft.device, createdAt: 30, ready: true, syncState: "synced" }],
      fromCache: false, hasPendingWrites: false,
    }));
    expect(within(screen.getByLabelText("Messages to yourself")).getAllByText("first share")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();

    const subscriptions = vi.mocked(test.value.cloud.subscribeItems).mock.calls.length;
    act(() => test.emitContexts([pending, ...contexts], { fromCache: false, hasPendingWrites: true }));
    expect(test.value.cloud.subscribeItems).toHaveBeenCalledTimes(subscriptions);
  });

  it("reads acknowledged offline history and still reports real permission errors", async () => {
    const test = services([{ ...contexts[0]!, syncState: "cached" }]);
    test.value.cloud.subscribeItems = vi.fn((_contextId, _emit, fail) => {
      fail(new Error("Missing or insufficient permissions."));
      return () => undefined;
    });
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Missing or insufficient permissions.");
    expect(test.value.cloud.subscribeItems).toHaveBeenCalledTimes(1);
  });

  it("keeps established cached history readable after restarting with an offline edit", async () => {
    const test = services();
    const first = render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await waitFor(() => expect(test.value.cloud.subscribeItems).toHaveBeenCalledTimes(1));
    act(() => test.emitContexts([{ ...contexts[0]!, syncState: "pending" }], { fromCache: true, hasPendingWrites: true }));
    first.unmount();
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await waitFor(() => expect(test.value.cloud.subscribeItems).toHaveBeenCalledTimes(2));
    expect(vi.mocked(test.value.cloud.subscribeItems).mock.calls[1]![0]).toBe(alpha);
  });

  it("shares typed content on Enter without trimming and supports explicit code mode", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const composer = await screen.findByLabelText("Message to yourself");
    await userEvent.click(screen.getByRole("button", { name: "Add files or code" }));
    await userEvent.click(screen.getByRole("button", { name: "Code mode" }));
    fireEvent.change(composer, { target: { value: "  const x = 1;\n" } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true, shiftKey: false, isComposing: false });

    await waitFor(() => expect(test.value.outbox.enqueue).toHaveBeenCalledTimes(1));
    expect(test.value.outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      contextId: alpha,
      createsContext: false,
      content: { kind: "code", text: "  const x = 1;\n" },
    }));
    expect(test.value.drain).toHaveBeenCalled();
  });

  it("explicitly sends pasted text and updates to existing contexts never change selection or clipboard", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const composer = await screen.findByLabelText("Message to yourself");
    fireEvent.paste(composer, { clipboardData: { files: [], getData: () => "pasted exactly" } });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(test.value.outbox.enqueue).toHaveBeenCalled());

    test.emitContexts([
      { ...contexts[1]!, updatedAt: 100 },
      contexts[0]!,
    ]);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(test.value.copyText).not.toHaveBeenCalled();
  });

  it("keeps context navigation and settings usable while filtering", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const search = await screen.findByLabelText("Search chat titles");
    await userEvent.type(search, "Beta");
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByText("alex@example.com")).toBeTruthy();
    expect(screen.getByText(/available in the desktop app/i)).toBeTruthy();
  });

  it("uses the native clipboard snapshot for desktop paste, including exact file bytes", async () => {
    const test = services();
    const readClipboard = vi.fn(async () => ({
      text: "file:///ignored.txt",
      files: [{ name: "native.txt", contentType: "text/plain", bytes: new Uint8Array([0, 1, 255]) }],
    }));
    test.value.readClipboard = readClipboard;
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const composer = await screen.findByLabelText("Message to yourself");
    fireEvent.paste(composer, { clipboardData: { files: [], getData: () => "file:///ignored.txt" } });
    await userEvent.click(await screen.findByRole("button", { name: "Send files" }));
    await waitFor(() => expect(test.value.outbox.enqueue).toHaveBeenCalled());
    expect(readClipboard).toHaveBeenCalledTimes(1);
    expect(test.value.outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      content: { kind: "attachment", name: "native.txt", contentType: "text/plain", size: 3 },
      bytes: new Uint8Array([0, 1, 255]),
    }));
  });

  it("shows and selects a tray-created context even while cloud sync is offline", async () => {
    const test = services();
    let notify: (() => void) | undefined;
    const trayContext = "00000000-0000-4000-8000-000000000099";
    const queued = {
      key: "native",
      namespace: "project:user",
      contextId: trayContext,
      itemId: "00000000-0000-4000-8000-000000000098",
      title: "Tray clipboard",
      content: { kind: "text" as const, text: "from tray" },
      device: test.value.device,
      createsContext: true,
      nativeRequestId: trayContext,
      attempts: 0,
      queuedAt: Date.now(),
      nextAttemptAt: 0,
      status: "pending" as const,
    };
    test.value.subscribeNativeShares = (listener) => { notify = listener; return () => undefined; };
    test.value.drainNativeShares = vi.fn(async () => {
      test.value.outbox.list = vi.fn(async () => [queued]);
      return trayContext;
    });
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await screen.findByRole("heading", { name: "Alpha" });
    notify?.();
    await screen.findByRole("heading", { name: "Tray clipboard" });
    expect(screen.getByText("from tray")).toBeTruthy();
    expect(test.items.has(trayContext)).toBe(false);
  });
  it("opens a new context by default and preserves a draft across an immediate remote switch", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
    const composer = screen.getByLabelText("Message to yourself");
    fireEvent.change(composer, { target: { value: "Unsent local work" } });
    await userEvent.click(screen.getByRole("button", { name: "Add files or code" }));
    await userEvent.click(screen.getByRole("button", { name: "Code mode" }));
    const incoming = { id: "00000000-0000-4000-8000-000000000088", title: "Remote context", createdAt: 30, updatedAt: 30, syncState: "synced" as const, originDeviceId: beta };
    act(() => test.emitContexts([incoming, ...contexts]));
    expect(screen.getByRole("heading", { name: "Remote context" })).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Draft · Unsent local work" }));
    expect((composer as HTMLTextAreaElement).value).toBe("Unsent local work");
    expect(screen.getByRole("button", { name: "Turn off code mode" })).toBeTruthy();
    act(() => test.emitContexts([{ ...incoming, title: "AI title" }, ...contexts]));
    expect((composer as HTMLTextAreaElement).value).toBe("Unsent local work");
    expect(test.value.copyText).not.toHaveBeenCalled();
    expect(test.value.cloud.subscribeContexts).toHaveBeenCalledTimes(1);
  });

  it("does not switch to a file until it is ready, and supports explicit context URLs", async () => {
    history.replaceState({}, "", `/contexts/${alpha}`);
    const test = services(); render(<ContextWorkspace services={test.value} />);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    const incoming = { id: "00000000-0000-4000-8000-000000000088", title: "Screenshot", createdAt: 30, updatedAt: 30, syncState: "synced" as const, ready: false };
    act(() => test.emitContexts([incoming, ...contexts]));
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    act(() => test.emitContexts([{ ...incoming, ready: true }, ...contexts]));
    expect(screen.getByRole("heading", { name: "Screenshot" })).toBeTruthy();
    expect(location.pathname).toBe(`/contexts/${incoming.id}`);
  });

  it("purges deleted contexts and returns to a fresh context", async () => {
    const test = services(); let deleted: ((ids: string[]) => void) | undefined;
    test.value.cloud.subscribeDeletedContexts = emit => { deleted = emit; return () => {}; };
    test.value.outbox.removeContext = vi.fn(async () => {});
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.change(screen.getByLabelText("Message to yourself"), { target: { value: "Remove this draft too" } });
    act(() => deleted?.([alpha]));
    expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
    await waitFor(async () => expect(JSON.stringify(await new DraftStore(test.value.outbox.namespace).list())).not.toContain("Remove this draft too"));
    expect(test.value.outbox.removeContext).toHaveBeenCalledWith(alpha);
  });

  it("does not apply an interrupted rename to an incoming context", async () => {
    const test = services(); render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Chat options" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename chat" }));
    fireEvent.change(screen.getByLabelText("Chat name"), { target: { value: "My draft rename" } });
    const incoming = { id: "00000000-0000-4000-8000-000000000088", title: "Remote", createdAt: 30, updatedAt: 30, syncState: "synced" as const };
    act(() => test.emitContexts([incoming, ...contexts]));
    expect(screen.getByRole("heading", { name: "Remote" })).toBeTruthy();
    expect(test.value.cloud.renameContext).not.toHaveBeenCalledWith(incoming.id, expect.anything());
  });

});


it("R4: Retry repeats the failed deletion instead of only draining shares", async () => {
  const test = services(); vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(test.value.cloud.deleteContext).mockRejectedValueOnce(new TypeError("offline"));
  render(<ContextWorkspace services={test.value} />);
  await userEvent.click(screen.getByRole("button", { name: "Options for Alpha" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete chat…" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete chat" }));
  expect((await screen.findByRole("alert")).textContent).toContain("not confirmed");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(test.value.cloud.deleteContext).toHaveBeenCalledTimes(2));
  vi.restoreAllMocks();
});
it("R5: removing an optimistic queued message removes the displayed content", async () => {
  const test = services([]); test.value.outbox.removeItem = vi.fn(async () => {});
  render(<ContextWorkspace services={test.value} />);
  fireEvent.paste(screen.getByLabelText("Message to yourself"), { clipboardData: { files: [], getData: () => "Queued synthetic text" } });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(test.value.outbox.enqueue).toHaveBeenCalledTimes(1));
  const record = vi.mocked(test.value.outbox.enqueue).mock.calls[0]![0];
  await userEvent.click(screen.getByRole("button", { name: "Message options" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete message…" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete message" }));
  await waitFor(() => expect(screen.queryByText("Queued synthetic text")).toBeNull());
  expect(test.value.outbox.removeItem).toHaveBeenCalledWith(record.contextId, record.itemId);
});
