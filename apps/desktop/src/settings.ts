import type { App } from "electron";
import type { NativeStore } from "./store.js";
function readLaunchSettings(
  app: Pick<App, "getLoginItemSettings">,
  platform: NodeJS.Platform = process.platform,
  executable: string = process.execPath,
) {
  // Electron 44 parses the Windows lookup path as a command line. Quote it
  // explicitly so spaces do not truncate it. Its registration comparison
  // strips surrounding quotes before formatting, so both checks stay exact.
  return app.getLoginItemSettings({
    ...(platform === "win32" ? { path: `"${executable}"` } : {}),
    args: ["--background"],
  });
}
export function isLaunchAtLoginEnabled(
  app: Pick<App, "getLoginItemSettings">,
  platform: NodeJS.Platform = process.platform,
  executable: string = process.execPath,
): boolean {
  const settings = readLaunchSettings(app, platform, executable);
  return (
    settings.openAtLogin &&
    (platform !== "win32" || settings.executableWillLaunchAtLogin)
  );
}
export function shouldStartHidden(
  platform: NodeJS.Platform,
  args: readonly string[],
  wasOpenedAtLogin: boolean,
): boolean {
  return (
    args.includes("--background") || (platform === "darwin" && wasOpenedAtLogin)
  );
}
export class LaunchSettings {
  constructor(
    private readonly app: Pick<
      App,
      "getLoginItemSettings" | "setLoginItemSettings"
    >,
    private readonly store: NativeStore,
  ) {}
  async initialize(): Promise<void> {
    const registered = readLaunchSettings(this.app);
    // Rewriting the Windows Run entry also clears StartupApproved. Preserve an
    // existing OS-disabled entry; only explicit user changes should re-enable it.
    if (
      this.store.launchAtLogin() &&
      (registered.openAtLogin || registered.status === "requires-approval")
    )
      return;
    this.apply(this.store.launchAtLogin());
  }
  private apply(enabled: boolean): void {
    this.app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ["--background"],
    });
  }
  enabled(): boolean {
    return isLaunchAtLoginEnabled(this.app);
  }
  async set(enabled: boolean): Promise<void> {
    const previous = this.store.launchAtLogin();
    this.apply(enabled);
    try {
      await this.store.setLaunchAtLogin(enabled);
    } catch (error) {
      this.apply(previous);
      throw error;
    }
    if (this.enabled() !== enabled)
      throw new Error(
        "The operating system did not accept the startup setting. Check your Login Items or Startup Apps settings.",
      );
  }
}
