import type { DesktopBridge, NativeFile } from "@mdc/contracts";
import { mobileBuild } from "./api.js";
import { inspectDesktopBridge } from "./desktop.js";

/** Desktop v1 remains unchanged; shared callers use only supported capabilities. */
export type NativePlatform = Omit<DesktopBridge, "version" | "platform" | "getLaunchAtLogin" | "setLaunchAtLogin"> &
  Partial<Pick<DesktopBridge, "getLaunchAtLogin" | "setLaunchAtLogin">>;
export type PlatformAdapter = {
  kind: "browser" | "desktop" | "android";
  native?: NativePlatform;
  activity?: { readonly initialActive: boolean; subscribe(listener: (active: boolean) => void): () => void };
  shareFile?: (file: NativeFile) => Promise<boolean>;
  dispose(): void;
};

export class DesktopUpdateRequiredError extends Error {}

export async function createPlatformAdapter(options: {
  mobile?: boolean;
  loadAndroid?: () => Promise<PlatformAdapter>;
} = {}): Promise<PlatformAdapter> {
  if (options.mobile ?? mobileBuild) {
    return (options.loadAndroid ?? (async () => (await import("./android.js")).createAndroidPlatform()))();
  }
  const desktop = inspectDesktopBridge();
  if (desktop.kind === "incompatible") {
    throw new DesktopUpdateRequiredError(`This desktop app uses bridge version ${String(desktop.actual)}. Install the current app to continue.`);
  }
  return desktop.kind === "ready"
    ? { kind: "desktop", native: desktop.bridge, dispose() {} }
    : { kind: "browser", dispose() {} };
}
