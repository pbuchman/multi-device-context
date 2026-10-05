// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatContextMenu } from "./chat-context-menu.js";

afterEach(cleanup);
function fixture(copy = true) {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const context = { id: "target", title: "Target chat" };
  const onClose = vi.fn(), onRename = vi.fn(), onDelete = vi.fn(), onCopy = vi.fn();
  const view = render(<ChatContextMenu context={context} anchor={{ x: 99999, y: 99999 }} opener={opener} onClose={onClose} onRename={onRename} onDelete={onDelete} onCopy={copy ? onCopy : undefined} />);
  return { ...view, opener, context, onClose, onRename, onDelete, onCopy };
}
it("focuses first action and supports wrapping keyboard navigation and target-specific activation", () => {
  const t = fixture();
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename chat" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete chat…" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(t.onCopy).toHaveBeenCalledWith(t.context);
  expect(t.onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(t.opener);
  t.opener.remove();
});
it("hides copy for unsent chats and restores focus on Escape or outside pointer down", () => {
  const t = fixture(false);
  expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(t.onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(t.opener);
  t.unmount(); t.opener.remove();
  const other = fixture(); fireEvent.pointerDown(document.body);
  expect(other.onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(other.opener); other.opener.remove();
});
it("clamps to viewport and does not steal focus from the modal opened by an action", () => {
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 210, height: 130 } as DOMRect);
  const t = fixture();
  const menu = screen.getByRole("menu");
  expect(menu.style.left).toBe(`${window.innerWidth - 218}px`);
  expect(menu.style.top).toBe(`${window.innerHeight - 138}px`);
  const modalInput = document.createElement("input"); document.body.append(modalInput);
  t.onRename.mockImplementation(() => modalInput.focus());
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename chat" }));
  t.unmount(); expect(document.activeElement).toBe(modalInput);
  modalInput.remove(); t.opener.remove(); rect.mockRestore();
});
it("reclamps on resize, supports End and returns focus when the target is removed", () => {
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 210, height: 130 } as DOMRect);
  const t = fixture();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete chat…" }));
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
  fireEvent(window, new Event("resize"));
  expect(screen.getByRole("menu").style.left).toBe("182px");
  t.unmount(); expect(document.activeElement).toBe(t.opener);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  t.opener.remove(); rect.mockRestore();
});
