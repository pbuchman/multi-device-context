// @vitest-environment jsdom
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

describe("ContextWorkspace", () => {
  it("waits for a new context to be acknowledged before reading its items", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "New context" }));
    fireEvent.paste(screen.getByLabelText("Paste to share instantly, or type a note"), {
      clipboardData: { files: [], getData: () => "first share" },
    });
    await waitFor(() => expect(test.value.drain).toHaveBeenCalled());
    const draft = vi.mocked(test.value.outbox.enqueue).mock.calls[0]![0];
    expect(draft.createsContext).toBe(true);
    expect(within(screen.getByLabelText("Shared items")).getByText("first share")).toBeTruthy();
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
    expect(within(screen.getByLabelText("Shared items")).getAllByText("first share")).toHaveLength(1);
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
    const composer = await screen.findByLabelText("Paste to share instantly, or type a note");
    await userEvent.click(screen.getByRole("button", { name: "Share as code" }));
    fireEvent.change(composer, { target: { value: "  const x = 1;\n" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false, isComposing: false });

    await waitFor(() => expect(test.value.outbox.enqueue).toHaveBeenCalledTimes(1));
    expect(test.value.outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      contextId: alpha,
      createsContext: false,
      content: { kind: "code", text: "  const x = 1;\n" },
    }));
    expect(test.value.drain).toHaveBeenCalled();
  });

  it("publishes pasted text immediately and updates to existing contexts never change selection or clipboard", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const composer = await screen.findByLabelText("Paste to share instantly, or type a note");
    fireEvent.paste(composer, { clipboardData: { files: [], getData: () => "pasted exactly" } });
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
    const search = await screen.findByLabelText("Search contexts");
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
    const composer = await screen.findByLabelText("Paste to share instantly, or type a note");
    fireEvent.paste(composer, { clipboardData: { files: [], getData: () => "file:///ignored.txt" } });
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
    expect(screen.getByRole("heading", { name: "New context" })).toBeTruthy();
    const composer = screen.getByLabelText("Paste to share instantly, or type a note");
    fireEvent.change(composer, { target: { value: "Unsent local work" } });
    await userEvent.click(screen.getByRole("button", { name: "Share as code" }));
    const incoming = { id: "00000000-0000-4000-8000-000000000088", title: "Remote context", createdAt: 30, updatedAt: 30, syncState: "synced" as const, originDeviceId: beta };
    act(() => test.emitContexts([incoming, ...contexts]));
    expect(screen.getByRole("heading", { name: "Remote context" })).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Draft · Unsent local work" }));
    expect((composer as HTMLTextAreaElement).value).toBe("Unsent local work");
    expect(screen.getByRole("button", { name: "Share as code" }).getAttribute("aria-pressed")).toBe("true");
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
    fireEvent.change(screen.getByLabelText("Paste to share instantly, or type a note"), { target: { value: "Remove this draft too" } });
    act(() => deleted?.([alpha]));
    expect(screen.getByRole("heading", { name: "New context" })).toBeTruthy();
    expect(localStorage.getItem("mdc-drafts:project:user")).not.toContain("Remove this draft too");
    expect(test.value.outbox.removeContext).toHaveBeenCalledWith(alpha);
  });

  it("does not apply an interrupted rename to an incoming context", async () => {
    const test = services(); render(<ContextWorkspace services={test.value} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await userEvent.click(screen.getByRole("button", { name: "Context options" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename context" }));
    fireEvent.change(screen.getByLabelText("Context name"), { target: { value: "My draft rename" } });
    const incoming = { id: "00000000-0000-4000-8000-000000000088", title: "Remote", createdAt: 30, updatedAt: 30, syncState: "synced" as const };
    act(() => test.emitContexts([incoming, ...contexts]));
    expect(screen.getByRole("heading", { name: "Remote" })).toBeTruthy();
    expect(test.value.cloud.renameContext).not.toHaveBeenCalledWith(incoming.id, expect.anything());
  });

});
