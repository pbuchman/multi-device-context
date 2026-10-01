// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@mdc/contracts";
import { createPlatformAdapter } from "./platform.js";

afterEach(() => { delete window.contextDesktop; });
it("keeps browser and desktop adapters independent of Android imports", async () => {
  const loadAndroid = vi.fn();
  expect((await createPlatformAdapter({ mobile: false, loadAndroid })).kind).toBe("browser");
  const bridge = { version: 1, platform: "linux" } as DesktopBridge;
  window.contextDesktop = bridge;
  const adapter = await createPlatformAdapter({ mobile: false, loadAndroid });
  expect(adapter.kind).toBe("desktop");
  expect(adapter.native).toBe(bridge);
  expect(loadAndroid).not.toHaveBeenCalled();
});
it("rejects incompatible desktop bridges and loads Android only for mobile builds", async () => {
  window.contextDesktop = { version: 2 } as unknown as DesktopBridge;
  await expect(createPlatformAdapter({ mobile: false })).rejects.toThrow("bridge version 2");
  const android = { kind: "android", dispose: vi.fn() } as const;
  const loadAndroid = vi.fn(async () => android);
  expect(await createPlatformAdapter({ mobile: true, loadAndroid })).toBe(android);
});
