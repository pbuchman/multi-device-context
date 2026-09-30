import { expect, it } from "vitest";
import { isLaunchAtLoginEnabled, shouldStartHidden } from "./settings.js";
import type { App } from "electron";
it("starts macOS login launches and Windows background launches in the tray", () => {
  expect(shouldStartHidden("darwin", [], true)).toBe(true);
  expect(shouldStartHidden("win32", ["app.exe", "--background"], false)).toBe(
    true,
  );
  expect(shouldStartHidden("darwin", [], false)).toBe(false);
  expect(shouldStartHidden("win32", ["app.exe"], false)).toBe(false);
});
it("queries the complete Windows executable path and respects OS startup disablement", () => {
  const exe =
    "C:\\Users\\Example\\Multi Device Context\\Multi Device Context.exe";
  let approved = true;
  const app = {
    getLoginItemSettings(options: unknown) {
      expect(options).toEqual({ path: `"${exe}"`, args: ["--background"] });
      return { openAtLogin: true, executableWillLaunchAtLogin: approved };
    },
  } as Pick<App, "getLoginItemSettings">;
  expect(isLaunchAtLoginEnabled(app, "win32", exe)).toBe(true);
  approved = false;
  expect(isLaunchAtLoginEnabled(app, "win32", exe)).toBe(false);
});
