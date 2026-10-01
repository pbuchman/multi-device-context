// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipboardSnapshot } from "@mdc/contracts";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";

const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
function fixture(platformKind: WorkspaceServices["platformKind"] = "desktop") {
  let navigate: ((id?: string) => void) | undefined;
  const services: WorkspaceServices = {
    platformKind, viewer: { uid: "compact-user", name: "Alex" }, device: { id: beta, name: "Laptop" },
    subscribeNavigation: listener => { navigate = listener; return () => {}; },
    cloud: {
      subscribeContexts: emit => { emit({ records: [alpha, beta].map((id, i) => ({ id, title: i ? "Beta" : "Alpha", createdAt: i + 1, updatedAt: i + 1, syncState: "synced" })), fromCache: false, hasPendingWrites: false }); return () => {}; },
      subscribeItems: (_, emit) => { emit({ records: [], fromCache: false, hasPendingWrites: false }); return () => {}; },
      renameContext: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}), attachmentBytes: vi.fn(async () => new Uint8Array()),
    },
    outbox: { namespace: `compact:${crypto.randomUUID()}`, enqueue: vi.fn(async () => {}), enqueueBatch: vi.fn(async () => {}), count: async () => 0, list: async () => [], clear: vi.fn(async () => {}), retry: async () => {} },
    drain: vi.fn(async () => {}), copyText: vi.fn(async () => {}), copyFile: vi.fn(async () => {}), saveFile: vi.fn(async () => true), signOut: vi.fn(async () => {}),
  };
  return { services, navigate: (id?: string) => navigate?.(id) };
}
const composer = () => screen.getByRole("textbox", { name: /Message to yourself|Paste to share instantly/ }) as HTMLTextAreaElement;
afterEach(() => { cleanup(); localStorage.clear(); history.replaceState({}, "", "/"); });

describe("compact chat input contract", () => {
  it("inserts ordinary pasted text at the selected range without publishing or inferring code", async () => {
    const t = fixture(); render(<ContextWorkspace services={t.services} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.change(composer(), { target: { value: "before old after" } });
    composer().setSelectionRange(7, 10);
    fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "```exact```" } });
    await act(async () => {});
    expect(composer().value).toBe("before ```exact``` after");
    expect(t.services.outbox.enqueueBatch).not.toHaveBeenCalled();
    expect(t.services.outbox.enqueue).not.toHaveBeenCalled();
  });

  it("keeps Enter as a new line in desktop code mode and sends only on Ctrl+Enter", async () => {
    const t = fixture(); render(<ContextWorkspace services={t.services} />);
    const existingToggle = screen.queryByRole("button", { name: "Share as code" });
    if (existingToggle) await userEvent.click(existingToggle);
    else { await userEvent.click(screen.getByRole("button", { name: "Add files or code" })); await userEvent.click(screen.getByRole("button", { name: "Code mode" })); }
    fireEvent.change(composer(), { target: { value: "first line" } });
    fireEvent.keyDown(composer(), { key: "Enter", code: "Enter" });
    await act(async () => {});
    expect(t.services.outbox.enqueueBatch).not.toHaveBeenCalled();
    fireEvent.keyDown(composer(), { key: "Enter", code: "Enter", ctrlKey: true });
    await waitFor(() => expect(t.services.outbox.enqueueBatch).toHaveBeenCalledTimes(1));
  });

  it("freezes a mixed native clipboard snapshot for confirmation and publishes nothing on cancel", async () => {
    const t = fixture(); const snapshot: ClipboardSnapshot = { text: "file caption", files: [{ name: "raw.bin", contentType: "application/octet-stream", bytes: new Uint8Array([0, 128, 255]) }] };
    t.services.readClipboard = vi.fn(async () => snapshot);
    render(<ContextWorkspace services={t.services} />);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "" } });
    await waitFor(() => expect(t.services.readClipboard).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(t.services.outbox.enqueueBatch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Send pasted files?" })).toBeTruthy();
    expect(screen.getByText("raw.bin")).toBeTruthy();
    expect(screen.getByText("file caption")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(t.services.outbox.enqueueBatch).not.toHaveBeenCalled();
  });
});

it("does not enqueue the same typed draft twice while its durable write is pending", async () => {
  const t = fixture(); let finish!: () => void;
  t.services.outbox.enqueueBatch = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<ContextWorkspace services={t.services} />);
  fireEvent.change(composer(), { target: { value: "one durable message" } });
  fireEvent.keyDown(composer(), { key: "Enter" });
  fireEvent.keyDown(composer(), { key: "Enter" });
  expect(t.services.outbox.enqueueBatch).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});

it("keeps an empty manually renamed local chat reachable after opening a fresh chat", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Chat options" }));
  await userEvent.click(screen.getByRole("button", { name: "Rename chat" }));
  fireEvent.change(screen.getByLabelText("Chat name"), { target: { value: "Next trip" } });
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await userEvent.click(screen.getByRole("button", { name: "New chat" }));
  await userEvent.click(screen.getByRole("button", { name: "Next trip" }));
  expect(screen.getByRole("heading", { name: "Next trip" })).toBeTruthy();
  expect(composer().value).toBe("");
});

it("inserts native text at the captured Unicode selection and rejects a later stale clipboard read", async () => {
  const t = fixture(); let finish!: (value: ClipboardSnapshot) => void;
  t.services.readClipboard = vi.fn(() => new Promise<ClipboardSnapshot>(resolve => { finish = resolve; }));
  render(<ContextWorkspace services={t.services} />);
  fireEvent.change(composer(), { target: { value: "before OLD after" } }); composer().setSelectionRange(7, 10);
  fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "" } });
  await act(async () => finish({ text: "żółć 😀", files: [] }));
  expect(composer().value).toBe("before żółć 😀 after");
  fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "" } });
  fireEvent.change(composer(), { target: { value: "newer draft" } });
  await act(async () => finish({ text: "stale", files: [] }));
  expect(composer().value).toBe("newer draft");
  expect(t.services.outbox.enqueueBatch).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Paste again");
});

it("publishes a frozen binary snapshot to its original chat without reselecting it", async () => {
  const t = fixture(); const bytes = new Uint8Array([0, 128, 255]);
  t.services.readClipboard = vi.fn(async () => ({ text: "caption", files: [{ name: "raw.bin", contentType: "application/octet-stream", bytes }] }));
  render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
  fireEvent.change(composer(), { target: { value: "keep my draft" } });
  fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "" } });
  await screen.findByRole("dialog", { name: "Send pasted files?" }); bytes[0] = 99;
  act(() => t.navigate(beta));
  await userEvent.click(screen.getByRole("button", { name: "Send files" }));
  await waitFor(() => expect(t.services.outbox.enqueueBatch).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(t.services.outbox.enqueueBatch!).mock.calls[0]![0];
  expect(sent.map(value => value.contextId)).toEqual([alpha, alpha]);
  expect(sent[0]!.content).toEqual({ kind: "text", text: "caption" });
  expect(sent[1]!.bytes).toEqual(new Uint8Array([0, 128, 255]));
  expect(t.services.readClipboard).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("heading", { name: "Beta" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Alpha" })); expect(composer().value).toBe("keep my draft");
});

it("treats failed sign-out inventory as an error and does not clear or sign out", async () => {
  const t = fixture(); t.services.accountSignOut = { locked: false, prepare: vi.fn(async () => { throw new Error("Inventory unavailable"); }), confirm: vi.fn(), retry: vi.fn() };
  render(<ContextWorkspace services={t.services} />);
  fireEvent.change(composer(), { target: { value: "unsent" } });
  await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Inventory unavailable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm sign out" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(composer().value).toBe("unsent");
  expect(t.services.signOut).not.toHaveBeenCalled(); expect(t.services.outbox.clear).not.toHaveBeenCalled();
});

it("discards a pending binary confirmation when its captured chat is deleted", async () => {
  const t = fixture(); let deleted!: (ids: string[]) => void;
  t.services.cloud.subscribeDeletedContexts = emit => { deleted = emit; return () => {}; };
  t.services.readClipboard = vi.fn(async () => ({ files: [{ name: "discard.bin", contentType: "application/octet-stream", bytes: new Uint8Array([1]) }] }));
  render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
  fireEvent.paste(composer(), { clipboardData: { files: [], getData: () => "" } });
  await screen.findByRole("dialog", { name: "Send pasted files?" });
  await act(async () => deleted([alpha]));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("The target chat was deleted. Pasted files were not sent.")).toBeTruthy();
  expect(t.services.outbox.enqueueBatch).not.toHaveBeenCalled();
});

it("freezes native lifecycle and external navigation after a failed auth invalidation without clearing drafts", async () => {
  const t = fixture("android"); let active!: (value: boolean) => void; let deleted!: (ids: string[]) => void; let locked = false;
  t.services.activity = { initialActive: true, subscribe: listener => { active = listener; return () => {}; } };
  t.services.cloud.setNetworkEnabled = vi.fn(async () => {});
  t.services.cloud.subscribeDeletedContexts = emit => { deleted = emit; return () => {}; };
  t.services.accountSignOut = { get locked() { return locked; }, prepare: vi.fn(async () => ({ token: "reviewed", drafts: 1, webShares: 2, nativeBatches: 3, deletions: 4 })), confirm: vi.fn(async () => { locked = true; throw new Error("Auth sign-out incomplete"); }), retry: vi.fn() };
  render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
  fireEvent.change(composer(), { target: { value: "preserve until auth succeeds" } });
  await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await userEvent.click(await screen.findByRole("button", { name: "Confirm sign out" }));
  await screen.findByText("Auth sign-out incomplete");
  const calls = vi.mocked(t.services.cloud.setNetworkEnabled).mock.calls.length;
  act(() => active(false)); act(() => active(true));
  act(() => { t.navigate(beta); deleted([alpha]); });
  await act(async () => {});
  expect(t.services.cloud.setNetworkEnabled).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
  expect(composer().value).toBe("preserve until auth succeeds"); expect(composer().disabled).toBe(true);
  expect(t.services.outbox.clear).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
});
