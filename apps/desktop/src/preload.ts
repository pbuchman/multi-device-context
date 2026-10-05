import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopCommandRequest, NativeFile } from "@mdc/contracts";
declare const MDC_APP_ORIGIN: string;
async function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(`mdc:${method}`, ...args)) as
    | { ok: true; value: T }
    | { ok: false; message: string };
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
if (process.isMainFrame && location.origin === MDC_APP_ORIGIN) {
  let commandRegistration: string | undefined;
  let stopCommands: (() => void) | undefined;
  const bridge: DesktopBridge & { readonly reviewedSignOut: true; exchangeInstallationSession(accessToken:string):Promise<unknown>; openAccessPanel(deviceId:string):Promise<void>; invalidateTransfers():Promise<void> } = {
    version: 1,
    onCommand: listener => {
      stopCommands?.();
      const registration = crypto.randomUUID();
      commandRegistration = registration;
      let active = true;
      const notify = (_event: unknown, value: unknown) => {
        if (!active || !value || typeof value !== "object") return;
        const request = value as Partial<DesktopCommandRequest>;
        if (typeof request.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.id)
          || !["new-chat", "delete-chat", "reload", "quit"].includes(request.command ?? "")) return;
        listener({ id: request.id, command: request.command! });
      };
      ipcRenderer.on("mdc:command", notify);
      void invoke("commandSubscription", registration, true).catch(() => {});
      const stop = () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener("mdc:command", notify);
        if (commandRegistration === registration) commandRegistration = undefined;
        void invoke("commandSubscription", registration, false).catch(() => {});
      };
      stopCommands = stop;
      return stop;
    },
    completeCommand: (id, allow) => {
      if (!commandRegistration) return Promise.reject(new Error("This application command has expired."));
      return invoke("completeCommand", commandRegistration, id, allow);
    },
    exchangeInstallationSession: accessToken => invoke("exchangeInstallationSession", accessToken),
    openAccessPanel: deviceId => invoke("openAccessPanel", deviceId),
    invalidateTransfers: () => invoke("invalidateTransfers"),
    reviewedSignOut: true,
    platform: process.platform as DesktopBridge["platform"],
    getDevice: () => invoke("getDevice"),
    getAccessToken: (interactive = false) =>
      invoke("getAccessToken", interactive),
    // Optional private argument binds cleanup to the exact reviewed inbox. The
    // exported v1 bridge stays unchanged; older no-argument callers fail closed.
    signOut: (reviewedNativeIds: readonly string[] = []) => invoke("signOut", reviewedNativeIds),
    readClipboard: () => invoke("readClipboard"),
    copyText: (text: string) => invoke("copyText", text),
    copyFile: (file: NativeFile) => invoke("copyFile", file),
    saveFile: (file: NativeFile) => invoke("saveFile", file),
    getLaunchAtLogin: () => invoke("getLaunchAtLogin"),
    setLaunchAtLogin: (enabled: boolean) => invoke("setLaunchAtLogin", enabled),
    getPendingClipboardShares: () => invoke("getPendingClipboardShares"),
    acknowledgeClipboardShare: (id: string) =>
      invoke("acknowledgeClipboardShare", id),
    takeNavigation: () => invoke("takeNavigation"),
    onNavigate: (listener) => {
      const notify = () => { void invoke<{ contextId?: string } | undefined>("takeNavigation").then(value => { if (value) listener(value); }).catch(() => {}); };
      ipcRenderer.on("mdc:navigate", notify);
      return () => ipcRenderer.removeListener("mdc:navigate", notify);
    },
    onShareClipboard: (listener) => {
      const notify = () => listener();
      ipcRenderer.on("mdc:shareClipboard", notify);
      return () => ipcRenderer.removeListener("mdc:shareClipboard", notify);
    },
  };
  contextBridge.exposeInMainWorld("contextDesktop", bridge);
} else if (process.isMainFrame && location.protocol === "file:") {
  contextBridge.exposeInMainWorld("contextRecovery", {
    retry: () => invoke("retry"),
  });
}
