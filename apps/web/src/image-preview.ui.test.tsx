// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AttachmentPreview } from "./media.js";
import type { ItemRecord } from "./model.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const item: ItemRecord = {
  id: "00000000-0000-4000-8000-000000000077",
  contextId: "00000000-0000-4000-8000-000000000001",
  content: { kind: "attachment", name: "polish-report.png", contentType: "image/png", size: 4 },
  device: { id: "00000000-0000-4000-8000-000000000010", name: "MacBook" },
  createdAt: 1,
  ready: true,
  syncState: "synced",
};

function setup() {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
  const cloud = { attachmentBytes: vi.fn(async () => new Uint8Array([137, 80, 78, 71])) };
  const onCopy = vi.fn();
  render(<div className="app-shell"><AttachmentPreview item={item} cloud={cloud} onCopy={onCopy} /></div>);
  return { cloud, onCopy };
}

it("opens an image inside the application and closes it with Escape", async () => {
  setup();
  const thumbnail = await screen.findByRole("button", { name: "Open image polish-report.png" });
  await userEvent.click(thumbnail);
  const dialog = screen.getByRole("dialog", { name: "Image preview: polish-report.png" });
  expect(within(dialog).getByRole("img", { name: "polish-report.png" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image preview: polish-report.png" })).toBeNull());
  expect(document.activeElement).toBe(thumbnail);
});

it("offers Copy image from right-click on both the thumbnail and enlarged image", async () => {
  const { onCopy } = setup();
  const thumbnail = await screen.findByRole("button", { name: "Open image polish-report.png" });
  fireEvent.contextMenu(thumbnail, { clientX: 24, clientY: 32 });
  await userEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
  expect(onCopy).toHaveBeenCalledTimes(1);

  await userEvent.click(thumbnail);
  const dialog = screen.getByRole("dialog", { name: "Image preview: polish-report.png" });
  fireEvent.contextMenu(within(dialog).getByRole("img", { name: "polish-report.png" }), { clientX: 40, clientY: 50 });
  await userEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
  expect(onCopy).toHaveBeenCalledTimes(2);
});

it("closes the image menu before closing the enlarged image with Escape", async () => {
  setup();
  const thumbnail = await screen.findByRole("button", { name: "Open image polish-report.png" });
  await userEvent.click(thumbnail);
  const dialog = screen.getByRole("dialog", { name: "Image preview: polish-report.png" });
  fireEvent.contextMenu(within(dialog).getByRole("img", { name: "polish-report.png" }), { clientX: 40, clientY: 50 });

  const menu = screen.getByRole("menu", { name: "Image actions" });
  fireEvent.keyDown(menu, { key: "Escape" });

  await waitFor(() => expect(screen.queryByRole("menu", { name: "Image actions" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "Image preview: polish-report.png" })).toBeTruthy();

  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image preview: polish-report.png" })).toBeNull());
});
