import { useEffect, useRef } from "react";
import type { DesktopCommandRequest } from "@mdc/contracts";

export type WorkspaceCommandRequest = DesktopCommandRequest;
type Options = {
  enabled: boolean;
  platform: "darwin" | "win32" | "linux";
  subscribe?: ((listener: (request: WorkspaceCommandRequest) => void) => () => void) | undefined;
  complete?: ((id: string, allow: boolean) => Promise<void>) | undefined;
  newChat(): void;
  deleteChat(): void;
  flush(): Promise<void>;
  reload(): void;
  error(message: string): void;
  freeze?(saving: boolean): void;
  blocked(): boolean;
  lifecycleBlocked?(): boolean;
  modal(): boolean;
};

/** Native menu commands and fallback keys share the existing workspace actions. */
export function useWorkspaceCommands(options: Options) {
  const latest = useRef(options); latest.current = options;
  const { enabled, platform, subscribe, complete } = options;
  useEffect(() => {
    if (!enabled) return;
    let active = true, finishing = false;
    const run = async (command: WorkspaceCommandRequest["command"], id?: string) => {
      const actions = latest.current;
      const lifecycle = command === "reload" || command === "quit";
      const reply = async (allow: boolean) => { if (active && id && complete) await complete(id, allow); };
      if (lifecycle ? (actions.lifecycleBlocked?.() ?? actions.blocked()) : actions.blocked()) { if (lifecycle) await reply(false).catch(() => {}); return; }
      if (finishing || (!lifecycle && actions.modal())) return;
      if (command === "new-chat") { actions.newChat(); return; }
      if (command === "delete-chat") { actions.deleteChat(); return; }
      finishing = true;
      actions.freeze?.(true);
      let approved = false;
      try {
        await actions.flush();
        if (!active) return;
        if (latest.current.lifecycleBlocked?.() ?? latest.current.blocked()) { await reply(false); return; }
        if (id) { await reply(true); approved = true; }
        else if (command === "reload") { actions.reload(); approved = true; }
      } catch (cause) {
        if (active) {
          actions.error(cause instanceof Error ? cause.message : "Could not save local work. Keep this app open and retry.");
          await reply(false).catch(() => {});
        }
      } finally {
        if (!approved) { finishing = false; if (active) actions.freeze?.(false); }
      }
    };
    if (subscribe && complete) {
      const unsubscribe = subscribe(request => { void run(request.command, request.id); });
      return () => { active = false; unsubscribe(); if (finishing) latest.current.freeze?.(false); };
    }
    // Older native clients can use the hosted shortcuts until their installer is
    // updated. Quit is intentionally native-only: window.close merely hides it.
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey) return;
      const modifier = platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      let command: WorkspaceCommandRequest["command"] | undefined;
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "n") command = "new-chat";
      if (modifier && !event.shiftKey && event.key.toLowerCase() === "r") command = "reload";
      if (modifier && event.shiftKey && event.key === "Backspace") command = "delete-chat";
      if (platform !== "darwin" && event.key === "F5" && !event.shiftKey && !event.ctrlKey && !event.metaKey) command = "reload";
      if (command) { event.preventDefault(); event.stopPropagation(); void run(command); }
    };
    window.addEventListener("keydown", key);
    return () => { active = false; window.removeEventListener("keydown", key); if (finishing) latest.current.freeze?.(false); };
  }, [enabled, platform, subscribe, complete]);
}
