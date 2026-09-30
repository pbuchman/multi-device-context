import type { App } from "electron";
import type { NativeStore } from "./store.js";
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
    this.apply(this.store.launchAtLogin());
  }
  private apply(enabled: boolean): void {
    this.app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ["--background"],
    });
  }
  enabled(): boolean {
    const settings = this.app.getLoginItemSettings({ args: ["--background"] });
    return (
      settings.openAtLogin &&
      (process.platform !== "win32" || settings.executableWillLaunchAtLogin)
    );
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
