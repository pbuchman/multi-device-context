// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceCommands, type WorkspaceCommandRequest } from "./workspace-commands.js";
afterEach(cleanup);
function setup(native = false, platform: "darwin" | "win32" = "darwin") {
  let listener: ((request: WorkspaceCommandRequest) => void) | undefined;
  const actions = { newChat: vi.fn(), deleteChat: vi.fn(), flush: vi.fn(async () => {}), reload: vi.fn(), error: vi.fn(), freeze: vi.fn(), blocked: () => false, modal: () => false };
  const complete = vi.fn(async () => {}), unsubscribe = vi.fn();
  const subscribe = vi.fn((callback: (request: WorkspaceCommandRequest) => void) => { listener = callback; return unsubscribe; });
  function Fixture({ blocked = false, modal = false }: { blocked?: boolean; modal?: boolean }) {
    useWorkspaceCommands({ enabled: true, platform, ...(native ? { subscribe, complete } : {}), ...actions, blocked: () => blocked, modal: () => modal });
    return <textarea aria-label="Draft" />;
  }
  const view = render(<Fixture />);
  return { ...actions, ...view, Fixture, complete, subscribe, unsubscribe, send: (command: WorkspaceCommandRequest["command"]) => listener!({ id: "request", command }) };
}
it("handles legacy desktop shortcuts without stealing standard text deletion", async () => {
  const t = setup();const input = document.querySelector("textarea")!;
  fireEvent.keyDown(input, { key: "n", metaKey: true });expect(t.newChat).toHaveBeenCalledOnce();
  fireEvent.keyDown(input, { key: "Backspace", metaKey: true });expect(t.deleteChat).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Backspace", metaKey: true, shiftKey: true });expect(t.deleteChat).toHaveBeenCalledOnce();
  fireEvent.keyDown(input, { key: "r", metaKey: true });await waitFor(() => expect(t.reload).toHaveBeenCalledOnce());expect(t.flush).toHaveBeenCalledOnce();
});
it("waits for durable local work before allowing native reload or quit", async () => {
  const t=setup(true);let finish!: () => void;t.flush.mockImplementation(() => new Promise(resolve => { finish=resolve; }));
  t.send("quit");expect(t.complete).not.toHaveBeenCalled();finish();
  await waitFor(() => expect(t.complete).toHaveBeenCalledWith("request",true));
  expect(t.reload).not.toHaveBeenCalled();
});
it("keeps the app open on save failure and ignores late completion after unmount", async () => {
  const t=setup(true);t.flush.mockRejectedValueOnce(new Error("Draft write failed"));t.send("reload");
  await waitFor(() => expect(t.complete).toHaveBeenCalledWith("request",false));expect(t.error).toHaveBeenCalledWith("Draft write failed");
  let finish!: () => void;t.flush.mockImplementation(() => new Promise(resolve => { finish=resolve; }));t.send("quit");t.unmount();finish();await Promise.resolve();
  expect(t.complete).toHaveBeenCalledTimes(1);expect(t.unsubscribe).toHaveBeenCalledOnce();
});
it("uses current modal/blocked state without resubscribing, and avoids duplicate keyboard actions with native menus", () => {
  const t=setup(true);t.send("new-chat");expect(t.newChat).toHaveBeenCalledOnce();
  fireEvent.keyDown(window,{key:"n",metaKey:true});expect(t.newChat).toHaveBeenCalledOnce();
  t.rerender(<t.Fixture modal />);t.send("delete-chat");expect(t.deleteChat).not.toHaveBeenCalled();
  t.rerender(<t.Fixture blocked />);t.send("new-chat");expect(t.newChat).toHaveBeenCalledOnce();expect(t.subscribe).toHaveBeenCalledOnce();
});

it("supports Windows Ctrl shortcuts and F5 while leaving normal deletion untouched", async () => {
  const t = setup(false, "win32");
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  expect(t.newChat).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: "Delete", ctrlKey: true });
  expect(t.deleteChat).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Backspace", ctrlKey: true, shiftKey: true });
  expect(t.deleteChat).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: "r", ctrlKey: true });
  await waitFor(() => expect(t.reload).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(window, { key: "F5" });
  expect(t.reload).toHaveBeenCalledTimes(1); // Already navigating: repeated requests stay locked.
  t.unmount(); const next = setup(false, "win32");
  fireEvent.keyDown(window, { key: "F5" });
  await waitFor(() => expect(next.reload).toHaveBeenCalledOnce());
  expect(next.flush).toHaveBeenCalledOnce();
});

it("freezes before saving, retains the lock after approval and restores input on failure", async () => {
  const t = setup(true); let finish!: () => void;
  t.flush.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  t.send("reload"); expect(t.freeze).toHaveBeenLastCalledWith(true);
  t.send("new-chat"); expect(t.newChat).not.toHaveBeenCalled();
  finish(); await waitFor(() => expect(t.complete).toHaveBeenCalledWith("request", true));
  expect(t.freeze).not.toHaveBeenCalledWith(false);
  t.unmount(); expect(t.freeze).toHaveBeenLastCalledWith(false);
  const failed = setup(true); failed.flush.mockRejectedValueOnce(new Error("disk full")); failed.send("quit");
  await waitFor(() => expect(failed.complete).toHaveBeenCalledWith("request", false));
  expect(failed.freeze).toHaveBeenLastCalledWith(false); failed.send("new-chat"); expect(failed.newChat).toHaveBeenCalledOnce();
});
it("unfreezes when account access becomes blocked while local writes settle", async () => {
  const t = setup(true); let finish!: () => void;
  t.flush.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); t.send("quit");
  t.rerender(<t.Fixture blocked />); finish(); await waitFor(() => expect(t.complete).toHaveBeenCalledWith("request", false));
  expect(t.freeze).toHaveBeenLastCalledWith(false);
});

it("allows lifecycle recovery while ordinary commands are blocked and no cleanup is active", async () => {
  const complete = vi.fn(async () => {}); let send!: (request: WorkspaceCommandRequest) => void;
  function Fixture() {
    useWorkspaceCommands({ enabled: true, platform: "darwin", subscribe: listener => { send = listener; return () => {}; }, complete,
      newChat() {}, deleteChat() {}, flush: async () => {}, reload() {}, error() {}, blocked: () => true, lifecycleBlocked: () => false, modal: () => false });
    return null;
  }
  render(<Fixture />); send({ id: "recovery", command: "quit" });
  await waitFor(() => expect(complete).toHaveBeenCalledWith("recovery", true));
});
