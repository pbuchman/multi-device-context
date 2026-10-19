// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import type { ContextRecord } from "./model.js";

const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
const gamma = "00000000-0000-4000-8000-000000000003";
const records = (): ContextRecord[] => [
  { id: alpha, title: "Alpha title that is much longer than the narrow sidebar", createdAt: 1, updatedAt: 1, syncState: "synced" },
  { id: beta, title: "Beta", createdAt: 2, updatedAt: 2, syncState: "synced" },
  { id: gamma, title: "Gamma", createdAt: 3, updatedAt: 3, syncState: "synced" },
];
const alphaTitle = records()[0]!.title;
function fixture(initial = records(), platformKind: WorkspaceServices["platformKind"] = "desktop") {
  let current = initial;
  let emit: (records: ContextRecord[], cached?: boolean) => void = () => {};
  const services: WorkspaceServices = {
    platformKind, viewer: { uid: "pin-user", name: "Alex" }, device: { id: alpha, name: "Laptop" },
    cloud: {
      subscribeContexts: listener => { emit = (records, cached = false) => { current = records; listener({ records, fromCache: cached, hasPendingWrites: false }); }; emit(current); return () => {}; },
      subscribeItems: (_, listener) => { listener({ records: [], fromCache: false, hasPendingWrites: false }); return () => {}; },
      setContextPinned: vi.fn(async () => {}), renameContext: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}), attachmentBytes: async () => new Uint8Array(),
    },
    outbox: { namespace: `pins:${crypto.randomUUID()}`, enqueue: vi.fn(async () => {}), count: async () => 0, list: async () => [], clear: async () => {}, retry: async () => {} },
    drain: async () => {}, copyText: async () => {}, copyFile: async () => {}, saveFile: async () => true, signOut: async () => {},
  };
  return { services, emit: (next: ContextRecord[], cached = false) => emit(next, cached), pin: (id: string, time: number | null) => emit(current.map(context => context.id === id ? { ...context, pinnedAt: time } : context)) };
}
const rowTitles = () => within(screen.getByRole("navigation", { name: "Your chats" })).getAllByRole("button").filter(element => element.classList.contains("context-select")).map(element => element.getAttribute("aria-label"));
const composer = () => screen.getByRole("textbox", { name: "Message to yourself" }) as HTMLTextAreaElement;
afterEach(() => { cleanup(); localStorage.clear(); history.replaceState({}, "", "/"); vi.restoreAllMocks(); });

it("sorts pins above local drafts and preserves the remaining order, including search results", async () => {
  const initial = records().map(record => ({ ...record, pinnedAt: record.id === beta ? 20 : record.id === gamma ? 10 : null }));
  const t = fixture(initial); render(<ContextWorkspace services={t.services} />);
  fireEvent.change(composer(), { target: { value: "Beta local draft" } });
  expect(rowTitles()).toEqual(["Beta", "Gamma", "Draft · Beta local draft", alphaTitle]);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "beta" } });
  expect(rowTitles()).toEqual(["Beta", "Draft · Beta local draft"]);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  await act(async () => t.pin(beta, null));
  expect(rowTitles()).toEqual(["Gamma", "Draft · Beta local draft", alphaTitle, "Beta"]);
});

it("uses current remote state in open keyboard menus and preserves active chat, composer cursor and unread state on remote reorders", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: alphaTitle }));
  fireEvent.change(composer(), { target: { value: "Keep this draft" } });
  composer().focus(); composer().setSelectionRange(3, 7);
  const field = composer();
  await act(async () => t.pin(beta, 20));
  expect(document.activeElement).toBe(field);
  expect(field.selectionStart).toBe(3); expect(field.selectionEnd).toBe(7);
  expect(field.value).toBe("Keep this draft");
  expect(screen.getByRole("button", { name: alphaTitle }).getAttribute("aria-current")).toBe("page");
  const betaRow = screen.getByRole("button", { name: "Beta" });
  expect(betaRow.getAttribute("aria-description")).toBe("Pinned chat");
  expect(betaRow.querySelector(".chat-pin svg")).toBeTruthy();
  expect(betaRow.querySelector("i")).toBeNull();
  fireEvent.keyDown(betaRow, { key: "F10", shiftKey: true });
  expect(screen.getByRole("menuitem", { name: "Unpin chat" })).toBeTruthy();
  await act(async () => t.pin(beta, null));
  const pin = screen.getByRole("menuitem", { name: "Pin chat" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(pin);
  fireEvent.keyDown(pin, { key: "Enter" });
  await waitFor(() => expect(t.services.cloud.setContextPinned).toHaveBeenCalledWith(beta, true));
  expect(composer()).toBe(field); expect(field.value).toBe("Keep this draft");
});

it("combines pinned and unread descriptions and keeps remote pin changes out of unread detection", async () => {
  const initial = records().map(record => record.id === beta ? { ...record, updatedAt: 10 } : record);
  const t = fixture(initial); render(<ContextWorkspace services={t.services} />);
  await act(async () => t.pin(beta, 30));
  expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-description")).toBe("Pinned chat. Unread messages");
  await userEvent.click(screen.getByRole("button", { name: "Beta" }));
  await userEvent.click(screen.getByRole("button", { name: alphaTitle }));
  await act(async () => t.pin(beta, null));
  expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-description")).toBeNull();
});

it("waits for acknowledgment, blocks repeat actions for the same chat, then permits retry after failure", async () => {
  const t = fixture(); let reject!: (cause: Error) => void;
  vi.mocked(t.services.cloud.setContextPinned!).mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
  render(<ContextWorkspace services={t.services} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Pin chat" }));
  expect(screen.queryByText("Chat pinned")).toBeNull();
  expect(screen.getByRole("button", { name: "Beta" }).querySelector(".chat-pin")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Options for Beta" }));
  const pending = screen.getByRole("menuitem", { name: "Pin chat" }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.getAttribute("aria-description")).toMatch(/Saving/);
  await userEvent.click(pending);
  expect(t.services.cloud.setContextPinned).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Connection lost")));
  expect(screen.getByText(/Connection lost.*retry/)).toBeTruthy();
  vi.mocked(t.services.cloud.setContextPinned!).mockImplementationOnce(async (id, pinned) => { t.pin(id, pinned ? 40 : null); });
  await userEvent.click(screen.getByRole("menuitem", { name: "Pin chat" }));
  await waitFor(() => expect(screen.getByText("Chat pinned")).toBeTruthy());
  expect(t.services.cloud.setContextPinned).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-description")).toBe("Pinned chat");
});

it("disables offline actions with an explanation and re-enables them when online", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  fireEvent(window, new Event("offline"));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
  expect((screen.getByRole("menuitem", { name: "Pin chat" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Go online to pin or unpin chats.")).toBeTruthy();
  expect(t.services.cloud.setContextPinned).not.toHaveBeenCalled();
  vi.mocked(Object.getOwnPropertyDescriptor(navigator, "onLine")!.get!).mockReturnValue(true);
  fireEvent(window, new Event("online"));
  expect((screen.getByRole("menuitem", { name: "Pin chat" }) as HTMLButtonElement).disabled).toBe(false);
});

it("hides pin for local and unacknowledged chats and offers current pin/unpin in the touch dialog", async () => {
  const t = fixture(records().map(record => record.id === gamma ? { ...record, syncState: "pending" } : record), "android");
  render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Options for Gamma" }));
  expect(screen.queryByRole("button", { name: "Pin chat" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.change(composer(), { target: { value: "Local" } });
  await userEvent.click(screen.getByRole("button", { name: "Options for Draft · Local" }));
  expect(screen.queryByRole("button", { name: "Pin chat" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  await userEvent.click(screen.getByRole("button", { name: "Options for Beta" }));
  expect(screen.getByRole("button", { name: "Pin chat" })).toBeTruthy();
  await act(async () => t.pin(beta, 50));
  await userEvent.click(screen.getByRole("button", { name: "Unpin chat" }));
  await waitFor(() => expect(t.services.cloud.setContextPinned).toHaveBeenCalledWith(beta, false));
});
