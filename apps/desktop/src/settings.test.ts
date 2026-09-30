import { expect, it } from "vitest";
import { shouldStartHidden } from "./settings.js";
it("starts macOS login launches and Windows background launches in the tray", () => {
  expect(shouldStartHidden("darwin", [], true)).toBe(true);
  expect(shouldStartHidden("win32", ["app.exe", "--background"], false)).toBe(
    true,
  );
  expect(shouldStartHidden("darwin", [], false)).toBe(false);
  expect(shouldStartHidden("win32", ["app.exe"], false)).toBe(false);
});
