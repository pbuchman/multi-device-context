// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

afterEach(() => cleanup());

function services() {
  let contextListener: ((snapshot: CloudSnapshot<ContextRecord>) => void) | undefined;
  const items = new Map<string, (snapshot: CloudSnapshot<ItemRecord>) => void>();
  const value: WorkspaceServices = {
    viewer: { uid: "user", name: "Alex", email: "alex@example.com" },
    device: { id: "00000000-0000-4000-8000-000000000010", name: "Dell Pro" },
    cloud: {
      subscribeContexts: vi.fn((emit) => {
        contextListener = emit;
        emit({ records: contexts, fromCache: false, hasPendingWrites: false });
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
  return { value, emitContexts: (records: ContextRecord[]) => contextListener?.({ records, fromCache: false, hasPendingWrites: false }) };
}

describe("ContextWorkspace", () => {
  it("shares typed content on Enter without trimming and supports explicit code mode", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
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

  it("publishes pasted text immediately and incoming updates never change selection or clipboard", async () => {
    const test = services();
    render(<ContextWorkspace services={test.value} />);
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
    const search = await screen.findByLabelText("Search contexts");
    await userEvent.type(search, "Beta");
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy();

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
    await screen.findByRole("heading", { name: "Alpha" });
    notify?.();
    await screen.findByRole("heading", { name: "Tray clipboard" });
    expect(screen.getByText("from tray")).toBeTruthy();
  });
});
