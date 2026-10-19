// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ContextOrigin } from "@mdc/contracts";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import { ChatSidebar } from "./workspace-view.js";
import type { ContextRecord } from "./model.js";
const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
const source = "00000000-0000-4000-8000-000000000009";
const records: ContextRecord[] = [alpha, beta].map((id, index) => ({ id, title: index ? "Beta" : "Alpha", createdAt: index + 1, updatedAt: index + 1, syncState: "synced", originDeviceId: source }));
const origin: ContextOrigin = { id: source, name: "Original laptop", colorIndex: 2 };
const origins = new Map([[source, origin]]);
afterEach(() => { cleanup(); localStorage.clear(); history.replaceState({}, "", "/"); });
function sidebar(contexts = records, selectedId = "") {
  return <ChatSidebar elementRef={{ current: null }} compact={false} open={false} contexts={contexts} origins={origins} selectedId={selectedId} search="" onSearch={() => {}} onSelect={() => {}} onNew={() => {}} onClose={() => {}} onOptions={() => {}} onContextMenu={() => {}} onSettings={() => {}} onRefresh={() => {}} refreshing={false} blocked={false} name="Alex" />;
}
function fixture(platformKind: WorkspaceServices["platformKind"] = "desktop") {
  let emit: (value: ContextRecord[]) => void = () => {};
  let current = records.map(record => ({ ...record }));
  const getContextOrigins = vi.fn(async () => [{ ...origin }]);
  const services: WorkspaceServices = {
    platformKind, viewer: { uid: "color-user", name: "Alex" }, device: { id: source, name: "Original laptop" },
    renameDevice: vi.fn(async name => ({ id: source, name })),
    cloud: {
      getContextOrigins,
      subscribeContexts: listener => { emit = value => listener({ records: value, fromCache: false, hasPendingWrites: false }); emit(current); return () => {}; },
      subscribeItems: (_, listener) => { listener({ records: [], fromCache: false, hasPendingWrites: false }); return () => {}; },
      refreshContexts: async () => ({ records: current, fromCache: false, hasPendingWrites: false }),
      refreshDeletedContexts: async () => [],
      setContextPinned: vi.fn(async (id, pinned) => { current = current.map(record => record.id === id ? { ...record, pinnedAt: pinned ? 99 : null } : record); emit(current); }),
      renameContext: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}), attachmentBytes: vi.fn(async () => new Uint8Array()),
    },
    outbox: { namespace: `colors:${crypto.randomUUID()}`, enqueue: vi.fn(async () => {}), count: async () => 0, list: async () => [], clear: vi.fn(async () => {}), retry: async () => {} },
    drain: vi.fn(async () => {}), copyText: vi.fn(async () => {}), copyFile: vi.fn(async () => {}), saveFile: vi.fn(async () => true), signOut: vi.fn(async () => {}),
  };
  return { services, getContextOrigins, emit: (value: ContextRecord[]) => { current = value; emit(value); } };
}
it("shows only titles and existing indicators at rest and identifies a source only through the ellipsis", async () => {
  render(sidebar());
  const nav = screen.getByRole("navigation", { name: "Your chats" });
  expect(nav.textContent).toBe("AlphaBeta");
  expect(screen.queryByRole("tooltip")).toBeNull();
  const title = screen.getByRole("button", { name: "Alpha" });
  fireEvent.mouseEnter(title.closest(".context-row")!);
  fireEvent.focus(title);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(title.getAttribute("title")).toBe("Alpha");
  const options = screen.getByRole("button", { name: "Options for Alpha" });
  fireEvent.mouseEnter(options);
  expect(screen.getByRole("tooltip").textContent).toBe("Created on: Original laptop");
  expect(options.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  fireEvent.mouseLeave(options);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(options);
  expect(screen.getByRole("tooltip").textContent).toBe("Created on: Original laptop");
  fireEvent.keyDown(options, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("keeps source palette through selection, filtering and pin ordering without adding list metadata", () => {
  const view = render(sidebar());
  const row = () => screen.getByRole("button", { name: "Alpha" }).closest(".context-row") as HTMLElement;
  const before = row().style.cssText;
  expect(row().dataset.originColor).toBe("2");
  expect(screen.getByRole("button", { name: "Beta" }).closest(".context-row")?.getAttribute("style")).toBe(before);
  view.rerender(sidebar([{ ...records[0]!, pinnedAt: 4, unread: true }], alpha));
  expect(row().classList.contains("selected")).toBe(true);
  expect(row().style.cssText).toBe(before);
  expect(row().querySelector(".chat-pin")).toBeTruthy();
  expect(row().querySelector("i")).toBeTruthy();
  expect(screen.queryByText(/Created on:/)).toBeNull();
  expect(screen.getByRole("navigation").textContent).toBe("Alpha");
});
it("adds quiet source metadata to desktop context menus while keeping keyboard actions and composer", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Alpha" }).closest(".context-row")?.getAttribute("data-origin-color")).toBe("2"));
  await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
  const composer = screen.getByRole("textbox", { name: "Message to yourself" }) as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: "Keep my draft" } });
  const betaTitle = screen.getByRole("button", { name: "Beta" });
  fireEvent.keyDown(betaTitle, { key: "F10", shiftKey: true });
  const menu = screen.getByRole("menu");
  expect(within(menu).getByText("Created on: Original laptop")).toBeTruthy();
  expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Rename chat", "Pin chat", "Copy link", "Delete chat…"]);
  expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Rename chat" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  await waitFor(() => expect(t.services.cloud.setContextPinned).toHaveBeenCalledWith(beta, true));
  expect(composer.value).toBe("Keep my draft");
  expect(screen.getByRole("button", { name: "Beta" }).closest(".context-row")?.getAttribute("data-origin-color")).toBe("2");
  expect(t.getContextOrigins).toHaveBeenCalledOnce();
});
it("retains the original source during pending saved-chat append/pin snapshots", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  const alphaRow = () => screen.getByRole("button", { name: "Alpha" }).closest(".context-row");
  await waitFor(() => expect(alphaRow()?.getAttribute("data-origin-color")).toBe("2"));
  await act(async () => t.emit(records.map(record => ({ ...record, syncState: "pending", updatedAt: 100, pinnedAt: 99 }))));
  expect(alphaRow()?.getAttribute("data-origin-color")).toBe("2");
  await act(async () => t.emit(records.map(record => ({ ...record, syncState: "synced", updatedAt: 100, pinnedAt: 99 }))));
  expect(alphaRow()?.getAttribute("data-origin-color")).toBe("2");
  expect(t.getContextOrigins).toHaveBeenCalledOnce();
});
it("identifies unknown sources neutrally in touch options without disabling actions", async () => {
  const t = fixture("android"); render(<ContextWorkspace services={t.services} />);
  const unknown = { ...records[0]! }; delete unknown.originDeviceId;
  await act(async () => t.emit([unknown]));
  const title = screen.getByRole("button", { name: "Alpha" });
  expect(title.closest(".context-row")?.getAttribute("data-origin-color")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Options for Alpha" }));
  const dialog = screen.getByRole("dialog", { name: "Chat options" });
  expect(within(dialog).getByText("Created on: Unknown device")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Rename chat" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Pin chat" })).toBeTruthy();
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("refreshes names manually and after own rename, keeping stable color and nonfatal errors", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  await waitFor(() => expect(t.getContextOrigins).toHaveBeenCalledOnce());
  t.getContextOrigins.mockResolvedValue([{ ...origin, name: "Renamed laptop" }]);
  await userEvent.click(screen.getByRole("button", { name: "Refresh chats and messages" }));
  await userEvent.click(screen.getByRole("button", { name: "Options for Alpha" }));
  expect(await screen.findByText("Created on: Renamed laptop")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await userEvent.click(screen.getByRole("button", { name: /Open settings/ }));
  await userEvent.click(screen.getByRole("button", { name: "Rename device" }));
  const input = screen.getByRole("textbox", { name: "Device name" });
  await userEvent.clear(input); await userEvent.type(input, "Current name");
  t.getContextOrigins.mockResolvedValue([{ ...origin, name: "Current name" }]);
  await userEvent.click(screen.getByRole("button", { name: "Save device name" }));
  await waitFor(() => expect(t.getContextOrigins).toHaveBeenCalledTimes(3));
  await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  t.getContextOrigins.mockRejectedValueOnce(new Error("Metadata unavailable"));
  await userEvent.click(screen.getByRole("button", { name: "Refresh chats and messages" }));
  await userEvent.click(screen.getByRole("button", { name: "Options for Alpha" }));
  expect(await screen.findByText("Created on: Current name")).toBeTruthy();
  expect(screen.queryByText("Metadata unavailable")).toBeNull();
});
