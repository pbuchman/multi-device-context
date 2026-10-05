import { randomUUID } from "node:crypto";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopCommandRequest } from "@mdc/contracts";

type Command = DesktopCommandRequest["command"];
/** A lifecycle acknowledgement belongs to exactly one renderer subscription. */
export class DesktopCommands {
  #registration: string | undefined;
  #pending: { request: DesktopCommandRequest; completion?: (allow: boolean) => void } | undefined;
  constructor(private readonly actions: {
    send(request: DesktopCommandRequest): void;
    newChat(): void;
    reload(): void;
    quit(): void;
    changed(): void;
  }) {}
  get ready() { return this.#registration !== undefined; }
  subscribe(registration: string) { this.#cancelPending(); this.#registration = registration; this.actions.changed(); }
  unsubscribe(registration: string) { if (this.#registration === registration) this.reset(); }
  reset() { this.#registration = undefined; this.#cancelPending(); this.actions.changed(); }
  request(command: Command, completion?: (allow: boolean) => void): boolean {
    if (this.#pending) return false;
    if (!this.ready) {
      if (completion && (command === "reload" || command === "quit")) completion(true);
      else {
        if (command === "new-chat") this.actions.newChat();
        if (command === "reload") this.actions.reload();
        if (command === "quit") this.actions.quit();
      }
      return true;
    }
    const request = { id: randomUUID(), command };
    if (command === "reload" || command === "quit") this.#pending = { request, ...(completion ? { completion } : {}) };
    this.actions.send(request);
    return true;
  }
  complete(registration: string, id: string, allow: boolean) {
    if (registration !== this.#registration || this.#pending?.request.id !== id) throw new Error("This application command has expired.");
    const { request, completion } = this.#pending;
    this.#pending = undefined;
    if (completion) { completion(allow); return; }
    if (!allow) return;
    if (request.command === "reload") this.actions.reload();
    if (request.command === "quit") this.actions.quit();
  }
  #cancelPending() {
    const completion = this.#pending?.completion;
    this.#pending = undefined;
    completion?.(false);
  }
}

export function applicationMenu(
  platform: string,
  name: string,
  ready: boolean,
  request: (command: Command) => void,
  checkForUpdates: () => void = () => {},
): MenuItemConstructorOptions[] {
  const quit: MenuItemConstructorOptions = { id: "quit", label: `Quit ${name}`, role: "quit", accelerator: "CmdOrCtrl+Q" };
  const file: MenuItemConstructorOptions[] = [
    { id: "new-chat", label: "New chat", accelerator: "CmdOrCtrl+N", click: () => request("new-chat") },
    { id: "delete-chat", label: "Delete chat…", accelerator: "CmdOrCtrl+Shift+Backspace", enabled: ready, click: () => request("delete-chat") },
    { type: "separator" },
    { id: "reload", label: "Reload", accelerator: "CmdOrCtrl+R", click: () => request("reload") },
    { id: "check-for-updates", label: "Check for updates…", click: checkForUpdates },
  ];
  if (platform !== "darwin") file.push({ type: "separator" }, quit);
  return [
    ...(platform === "darwin" ? [{ label: name, submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, quit] } as MenuItemConstructorOptions] : []),
    { label: "File", submenu: file },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
}
