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
  expect(adapter.native?.signOut).toBeTypeOf("function");
  expect(loadAndroid).not.toHaveBeenCalled();
});
it("refuses old desktop sign-out even when its current inbox is empty", async () => {
  const signOut = vi.fn(async () => {});
  window.contextDesktop = { version: 1, platform: "linux", signOut } as unknown as DesktopBridge;
  const adapter = await createPlatformAdapter({ mobile: false });
  await expect(adapter.native!.signOut([])).rejects.toThrow(/Update this desktop app/);
  expect(signOut).not.toHaveBeenCalled();
});
it("passes the exact reviewed snapshot only to a compatible private desktop implementation", async () => {
  const signOut = vi.fn(async () => {});
  window.contextDesktop = { version: 1, platform: "linux", reviewedSignOut: true, signOut } as unknown as DesktopBridge;
  const adapter = await createPlatformAdapter({ mobile: false });
  await adapter.native!.signOut(["reviewed"]);
  expect(signOut).toHaveBeenCalledWith(["reviewed"]);
});
it("rejects incompatible desktop bridges and loads Android only for mobile builds", async () => {
  window.contextDesktop = { version: 2 } as unknown as DesktopBridge;
  await expect(createPlatformAdapter({ mobile: false })).rejects.toThrow("bridge version 2");
  const android = { kind: "android", dispose: vi.fn() } as const;
  const loadAndroid = vi.fn(async () => android);
  expect(await createPlatformAdapter({ mobile: true, loadAndroid })).toBe(android);
});
