import { randomUUID } from "node:crypto";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopCommandRequest } from "@mdc/contracts";

type Command = DesktopCommandRequest["command"];
/** A lifecycle acknowledgement belongs to exactly one renderer subscription. */
export class DesktopCommands {
  #registration: string | undefined;
  #pending: DesktopCommandRequest | undefined;
  constructor(private readonly actions: {
    send(request: DesktopCommandRequest): void;
    newChat(): void;
    reload(): void;
    quit(): void;
    changed(): void;
  }) {}
  get ready() { return this.#registration !== undefined; }
  subscribe(registration: string) { this.#registration = registration; this.#pending = undefined; this.actions.changed(); }
  unsubscribe(registration: string) { if (this.#registration === registration) this.reset(); }
  reset() { this.#registration = undefined; this.#pending = undefined; this.actions.changed(); }
  request(command: Command) {
    if (this.#pending) return;
    if (!this.ready) {
      if (command === "new-chat") this.actions.newChat();
      if (command === "reload") this.actions.reload();
      if (command === "quit") this.actions.quit();
      return;
    }
    const request = { id: randomUUID(), command };
    if (command === "reload" || command === "quit") this.#pending = request;
    this.actions.send(request);
  }
  complete(registration: string, id: string, allow: boolean) {
    if (registration !== this.#registration || this.#pending?.id !== id) throw new Error("This application command has expired.");
    const command = this.#pending.command;
    this.#pending = undefined;
    if (!allow) return;
    if (command === "reload") this.actions.reload();
    if (command === "quit") this.actions.quit();
  }
}

export function applicationMenu(platform: string, name: string, ready: boolean, request: (command: Command) => void): MenuItemConstructorOptions[] {
  const quit: MenuItemConstructorOptions = { id: "quit", label: `Quit ${name}`, role: "quit", accelerator: "CmdOrCtrl+Q" };
  const file: MenuItemConstructorOptions[] = [
    { id: "new-chat", label: "New chat", accelerator: "CmdOrCtrl+N", click: () => request("new-chat") },
    { id: "delete-chat", label: "Delete chat…", accelerator: "CmdOrCtrl+Shift+Backspace", enabled: ready, click: () => request("delete-chat") },
    { type: "separator" },
    { id: "reload", label: "Reload", accelerator: "CmdOrCtrl+R", click: () => request("reload") },
  ];
  if (platform !== "darwin") file.push({ type: "separator" }, quit);
  return [
    ...(platform === "darwin" ? [{ label: name, submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, quit] } as MenuItemConstructorOptions] : []),
    { label: "File", submenu: file },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
}
