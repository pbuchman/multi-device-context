// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";
const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
function fixture(platformKind: WorkspaceServices["platformKind"] = "desktop") {
  let emitContexts: (records: import("./model.js").ContextRecord[]) => void = () => {};
  let navigate: ((id?: string) => void) | undefined;
  const services: WorkspaceServices = {
    platformKind, viewer: { uid: "compact-user", name: "Alex" }, device: { id: beta, name: "Laptop" },
    subscribeNavigation: listener => { navigate = listener; return () => {}; },
    cloud: {
      subscribeContexts: emit => { emitContexts = records => emit({ records, fromCache: false, hasPendingWrites: false }); emit({ records: [alpha, beta].map((id, i) => ({ id, title: i ? "Beta" : "Alpha", createdAt: i + 1, updatedAt: i + 1, syncState: "synced" })), fromCache: false, hasPendingWrites: false }); return () => {}; },
      subscribeItems: (_, emit) => { emit({ records: [], fromCache: false, hasPendingWrites: false }); return () => {}; },
      renameContext: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}), attachmentBytes: vi.fn(async () => new Uint8Array()),
    },
    outbox: { namespace: `compact:${crypto.randomUUID()}`, enqueue: vi.fn(async () => {}), enqueueBatch: vi.fn(async () => {}), count: async () => 0, list: async () => [], clear: vi.fn(async () => {}), retry: async () => {} },
    drain: vi.fn(async () => {}), copyText: vi.fn(async () => {}), copyFile: vi.fn(async () => {}), saveFile: vi.fn(async () => true), signOut: vi.fn(async () => {}),
  };
  return { services, emitContexts: (ids: string[]) => emitContexts(ids.map((id, i) => ({ id, title: i ? "Beta" : "Alpha", createdAt: i + 1, updatedAt: i + 1, syncState: "synced" }))), navigate: (id?: string) => navigate?.(id) };
}
const composer = () => screen.getByRole("textbox", { name: /Message to yourself|Paste to share instantly/ }) as HTMLTextAreaElement;
afterEach(() => { cleanup(); localStorage.clear(); history.replaceState({}, "", "/"); });


it("opens the clicked chat menu without changing the selected chat or its draft", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
  fireEvent.change(composer(), { target: { value: "Keep Alpha draft" } });
  fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }), { clientX: 100, clientY: 200 });
  expect(screen.getByRole("menu", { name: "Options for Beta" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-current")).toBe("page");
  expect(composer().value).toBe("Keep Alpha draft");
  await userEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
  expect(t.services.copyText).toHaveBeenCalledWith(`${location.origin}/contexts/${beta}`);
  expect(composer().value).toBe("Keep Alpha draft");
});
it("routes rename and confirmed delete to the menu target", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Options for Beta" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename chat" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), { target: { value: "Renamed Beta" } });
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(t.services.cloud.renameContext).toHaveBeenCalledWith(beta, "Renamed Beta"));
  await userEvent.click(screen.getByRole("button", { name: "Options for Renamed Beta" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete chat…" }));
  expect(t.services.cloud.deleteContext).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Delete chat" }));
  await waitFor(() => expect(t.services.cloud.deleteContext).toHaveBeenCalledWith(beta));
});
it("opens with Control-click and keyboard, then closes when sync removes its target", async () => {
  const t = fixture(); render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
  const betaRow = screen.getByRole("button", { name: "Beta" });
  fireEvent.click(betaRow, { ctrlKey: true });
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-current")).toBe("page");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.keyDown(betaRow, { key: "F10", shiftKey: true });
  expect(screen.getByRole("menu")).toBeTruthy();
  await act(async () => t.emitContexts([alpha]));
  expect(screen.queryByRole("menu")).toBeNull();
});
it("hides copying for a local unsent chat and closes on account replacement", async () => {
  const t = fixture(); const view = render(<ContextWorkspace services={t.services} />);
  fireEvent.change(composer(), { target: { value: "Local draft" } });
  await userEvent.click(screen.getByRole("button", { name: "Options for Draft · Local draft" }));
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull();
  const other = fixture(); view.rerender(<ContextWorkspace services={other.services} />);
  expect(screen.queryByRole("menu")).toBeNull();
});
it("keeps the phone options panel", async () => {
  const t = fixture("android"); render(<ContextWorkspace services={t.services} />);
  await userEvent.click(screen.getByRole("button", { name: "Options for Beta" }));
  expect(screen.getByRole("dialog", { name: "Chat options" })).toBeTruthy();
  expect(screen.queryByRole("menu")).toBeNull();
});
