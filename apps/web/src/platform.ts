import type { DesktopBridge, NativeFile } from "@mdc/contracts";
import { mobileBuild } from "./api.js";
import { inspectDesktopBridge } from "./desktop.js";

/** Desktop v1 remains unchanged; shared callers use only supported capabilities. */
export type NativePlatform = Omit<DesktopBridge, "version" | "platform" | "getLaunchAtLogin" | "setLaunchAtLogin" | "signOut"> &
  Partial<Pick<DesktopBridge, "getLaunchAtLogin" | "setLaunchAtLogin">> & {
    /** Private adapter argument, never part of the public DesktopBridge v1 contract. */
    signOut(reviewedNativeIds?: readonly string[]): Promise<void>;
  };
export type PlatformAdapter = {
  kind: "browser" | "desktop" | "android";
  native?: NativePlatform;
  /** Native helpers keep installation credentials out of the renderer. */
  exchangeSession?(accessToken: string): Promise<unknown>;
  openAccessPanel?(deviceId: string): Promise<void>;
  invalidateTransfers?(): Promise<void>;
  activity?: { readonly initialActive: boolean; subscribe(listener: (active: boolean) => void): () => void };
  shareFile?: (file: NativeFile) => Promise<boolean>;
  assertCanSignOut?(): void;
  dispose(): void;
};

export class DesktopUpdateRequiredError extends Error {}

/** Only the installed preload advertises this private implementation affordance. */
type ReviewedDesktopBridge = DesktopBridge & { exchangeInstallationSession?(accessToken: string): Promise<unknown>; openAccessPanel?(deviceId: string): Promise<void>; invalidateTransfers?(): Promise<void>; readonly reviewedSignOut?: true; signOut(reviewedIds?: readonly string[]): Promise<void> };

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
  if (desktop.kind !== "ready") return { kind: "browser", dispose() {} };
  const bridge = desktop.bridge as ReviewedDesktopBridge;
  const assertCanSignOut = () => {
    if (bridge.reviewedSignOut !== true) throw new DesktopUpdateRequiredError("Update this desktop app before signing out. This installed version cannot safely preserve newly arriving shares; your local data has not been cleared.");
  };
  return { kind: "desktop", assertCanSignOut,
    ...(bridge.exchangeInstallationSession ? { exchangeSession: (token: string) => bridge.exchangeInstallationSession!(token) } : {}),
    ...(bridge.openAccessPanel ? { openAccessPanel: (id: string) => bridge.openAccessPanel!(id) } : {}),
    ...(bridge.invalidateTransfers ? { invalidateTransfers: () => bridge.invalidateTransfers!() } : {}),
    native: {
    ...bridge,
    signOut: async (reviewedIds = []) => {
      assertCanSignOut();
      await bridge.signOut(reviewedIds);
    },
  }, dispose() {} };
}
