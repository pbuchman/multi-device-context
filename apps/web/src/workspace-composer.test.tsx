// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatComposer } from "./workspace-view.js";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";

afterEach(() => { cleanup(); localStorage.clear(); history.replaceState({}, "", "/"); });
const text = "Existing draft with words\nand a second line";
function setup(blocked = false) {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const callbacks = { onText: vi.fn(), onPaste: vi.fn(), onKey: vi.fn(), onAdd: vi.fn(), onCodeOff: vi.fn(), onFastPaste: vi.fn(), onSend: vi.fn() };
  render(<ChatComposer text={text} code={false} android nativeClipboard={false} blocked={blocked} sending={false} textareaRef={textareaRef} {...callbacks} />);
  return { field: textareaRef.current!, ...callbacks };
}
function pointer(field: HTMLTextAreaElement, { button = 0, primary = true, type = "mouse" } = {}) {
  const event = new MouseEvent("pointerdown", { button, bubbles: true, cancelable: true });
  Object.defineProperties(event, { isPrimary: { value: primary }, pointerType: { value: type } });
  fireEvent(field, event);
  return event;
}
it("first pointer activation focuses at the end without editing or sending", () => {
  const t = setup(); t.field.setSelectionRange(2, 5);
  expect(pointer(t.field).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(t.field);
  expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([text.length, text.length]);
  expect(t.field.value).toBe(text); expect(t.onText).not.toHaveBeenCalled(); expect(t.onSend).not.toHaveBeenCalled();
});
it("already focused pointer gestures preserve a caret or range and native defaults", () => {
  const t = setup(); t.field.focus();
  for (const range of [[3, 3], [2, 12]]) {
    t.field.setSelectionRange(range[0]!, range[1]!);
    expect(pointer(t.field).defaultPrevented).toBe(false);
    expect([t.field.selectionStart, t.field.selectionEnd]).toEqual(range);
  }
});
it("another activation after blur again uses the end", () => {
  const t = setup(); pointer(t.field); t.field.setSelectionRange(1, 1); t.field.blur();
  expect(pointer(t.field).defaultPrevented).toBe(true);
  expect(t.field.selectionStart).toBe(text.length);
});
it("primary touch and pen activation use the same focus rule", () => {
  for (const type of ["touch", "pen"]) {
    const t = setup(); expect(pointer(t.field, { type }).defaultPrevented).toBe(true);
    expect(t.field.selectionStart).toBe(text.length); cleanup();
  }
});
it("secondary buttons and non-primary pointers do not steal focus or selection", () => {
  const t = setup(); t.field.setSelectionRange(1, 4);
  expect(pointer(t.field, { button: 2 }).defaultPrevented).toBe(false);
  expect(pointer(t.field, { primary: false }).defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(t.field);
  expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([1, 4]);
});
it("disabled composer does not gain focus or change its selection", () => {
  const t = setup(true); t.field.setSelectionRange(1, 4);
  expect(pointer(t.field).defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(t.field);
  expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([1, 4]);
});
it("programmatic focus and paste selection restoration remain controlled by their caller", () => {
  const t = setup(); t.field.setSelectionRange(2, 8); t.field.focus();
  expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([2, 8]);
  fireEvent.paste(t.field, { clipboardData: { getData: () => "synthetic paste" } });
  expect(t.onPaste).toHaveBeenCalledOnce();
  expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([2, 8]);
});
it("focused IME composition and keyboard handling are not intercepted", () => {
  const t = setup(); t.field.focus(); t.field.setSelectionRange(4, 4);
  fireEvent.compositionStart(t.field, { data: "" });
  expect(pointer(t.field).defaultPrevented).toBe(false);
  fireEvent.keyDown(t.field, { key: "Process", isComposing: true });
  fireEvent.compositionEnd(t.field, { data: "synthetic" });
  expect(t.field.selectionStart).toBe(4); expect(t.onKey).toHaveBeenCalledOnce(); expect(t.onSend).not.toHaveBeenCalled();
});
it("starting without a chat keeps an empty local draft and focusing cannot send it", async () => {
  const services: WorkspaceServices = {
    platformKind: "android",
    viewer: { uid: "composer-test", name: "Synthetic user", email: "composer@example.com" },
    device: { id: "00000000-0000-4000-8000-000000000010", name: "Synthetic phone" },
    cloud: {
      subscribeContexts: vi.fn(emit => { emit({ records: [], fromCache: false, hasPendingWrites: false }); return () => {}; }),
      subscribeItems: vi.fn(() => () => {}),
      renameContext: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}),
      attachmentBytes: vi.fn(async () => new Uint8Array()),
    },
    outbox: {
      namespace: `composer-test:${crypto.randomUUID()}`, enqueue: vi.fn(async () => {}),
      count: vi.fn(async () => 0), clear: vi.fn(async () => {}), retry: vi.fn(async () => {}), list: vi.fn(async () => []),
    },
    drain: vi.fn(async () => {}), copyText: vi.fn(async () => {}), copyFile: vi.fn(async () => {}),
    saveFile: vi.fn(async () => true), signOut: vi.fn(async () => {}),
  };
  render(<ContextWorkspace services={services} />);
  await waitFor(() => expect(services.outbox.list).toHaveBeenCalled());
  const field = screen.getByRole("textbox", { name: "Message to yourself" }) as HTMLTextAreaElement;
  expect(screen.getByRole("heading", { name: "New chat" })).toBeTruthy();
  expect(pointer(field).defaultPrevented).toBe(true);
  expect(field.value).toBe(""); expect(field.selectionStart).toBe(0);
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  expect(services.outbox.enqueue).not.toHaveBeenCalled();
  expect(services.cloud.subscribeItems).not.toHaveBeenCalled();
  expect(services.cloud.renameContext).not.toHaveBeenCalled();
  expect(location.pathname).toBe("/");
});
