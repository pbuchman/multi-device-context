import { expect, it, vi } from "vitest";
import { DesktopCommands, applicationMenu } from "./commands.js";

function fixture() {
  const actions = { send: vi.fn(), newChat: vi.fn(), reload: vi.fn(), quit: vi.fn(), changed: vi.fn() };
  return { commands: new DesktopCommands(actions), actions };
}
it("keeps login/recovery usable without a command subscriber", () => {
  const { commands, actions } = fixture();
  commands.request("new-chat"); commands.request("delete-chat"); commands.request("reload"); commands.request("quit");
  expect(actions.newChat).toHaveBeenCalledOnce(); expect(actions.reload).toHaveBeenCalledOnce(); expect(actions.quit).toHaveBeenCalledOnce(); expect(actions.send).not.toHaveBeenCalled();
});
it("routes workspace actions and waits for matching acknowledgement before reload or quit", () => {
  const { commands, actions } = fixture(); commands.subscribe("registration");
  commands.request("new-chat"); expect(actions.send).toHaveBeenLastCalledWith(expect.objectContaining({ command: "new-chat" }));
  commands.request("delete-chat"); expect(actions.send).toHaveBeenLastCalledWith(expect.objectContaining({ command: "delete-chat" }));
  commands.request("reload"); const request = actions.send.mock.lastCall![0];
  commands.request("reload"); commands.request("quit"); expect(actions.send).toHaveBeenCalledTimes(3);
  expect(actions.reload).not.toHaveBeenCalled();
  expect(() => commands.complete("wrong", request.id, true)).toThrow();
  expect(() => commands.complete("registration", "wrong", true)).toThrow();
  commands.complete("registration", request.id, false); expect(actions.reload).not.toHaveBeenCalled();
  commands.request("quit"); commands.complete("registration", actions.send.mock.lastCall![0].id, true);
  expect(actions.quit).toHaveBeenCalledOnce();
});
it("invalidates pending lifecycle requests on unsubscribe and navigation", () => {
  const { commands, actions } = fixture(); commands.subscribe("old"); commands.request("quit"); const old = actions.send.mock.lastCall![0];
  commands.subscribe("new"); commands.unsubscribe("old"); expect(commands.ready).toBe(true);
  expect(() => commands.complete("old", old.id, true)).toThrow();
  commands.request("reload"); const next = actions.send.mock.lastCall![0]; commands.reset();
  expect(commands.ready).toBe(false); expect(() => commands.complete("new", next.id, true)).toThrow();
  expect(actions.reload).not.toHaveBeenCalled(); expect(actions.quit).not.toHaveBeenCalled();
});
it.each(["darwin", "win32"])("provides visible %s menus with native shortcuts", platform => {
  const action = vi.fn(); const template = applicationMenu(platform, "Multi Device Context", true, action);
  const file = template.find(item => item.label === "File")!;
  const items = file.submenu as import("electron").MenuItemConstructorOptions[];
  expect(items.find(item => item.id === "new-chat")).toMatchObject({ accelerator: "CmdOrCtrl+N" });
  expect(items.find(item => item.id === "delete-chat")).toMatchObject({ accelerator: "CmdOrCtrl+Shift+Backspace", enabled: true });
  expect(items.find(item => item.id === "reload")).toMatchObject({ accelerator: "CmdOrCtrl+R" });
  const all = template.flatMap(item => Array.isArray(item.submenu) ? item.submenu : []);
  expect(all.find(item => item.id === "quit")).toMatchObject({ role: "quit", accelerator: "CmdOrCtrl+Q" });
  expect(template.some(item => item.role === "editMenu")).toBe(true);
  expect(template.some(item => item.role === "windowMenu")).toBe(true);
  (items.find(item => item.id === "reload")!.click as () => void)(); expect(action).toHaveBeenCalledWith("reload");
});
