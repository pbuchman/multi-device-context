// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@mdc/contracts";
import { createPlatformAdapter, NativeSignOutReviewRequired } from "./platform.js";

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
it("exposes native updates only when every optional v1 capability is present", async () => {
  const base = { version: 1, platform: "darwin" } as unknown as DesktopBridge;
  window.contextDesktop = { ...base, getUpdateState: vi.fn() };
  expect((await createPlatformAdapter({ mobile: false })).updates).toBeUndefined();
  window.contextDesktop = {
    ...base,
    getUpdateState: vi.fn(), checkForUpdates: vi.fn(), startUpdate: vi.fn(),
    installUpdate: vi.fn(), onUpdateState: vi.fn(),
  };
  expect((await createPlatformAdapter({ mobile: false })).updates).toBeDefined();
});
it.each([undefined, true])("refuses old desktop sign-out even when its inbox is empty (legacy review marker=%s)", async reviewedSignOut => {
  const signOut = vi.fn(async () => {});
  window.contextDesktop = { version: 1, platform: "linux", reviewedSignOut, signOut } as unknown as DesktopBridge;
  const adapter = await createPlatformAdapter({ mobile: false });
  await expect(adapter.native!.signOut([])).rejects.toThrow(/Update this desktop app/);
  expect(signOut).not.toHaveBeenCalled();
});
it("passes the exact reviewed snapshot only to a compatible private desktop implementation", async () => {
  const signOutReviewed = vi.fn(async () => ({ status: "complete" as const }));
  window.contextDesktop = { version: 1, platform: "linux", signOutReviewed } as unknown as DesktopBridge;
  const adapter = await createPlatformAdapter({ mobile: false });
  await adapter.native!.signOut(["reviewed"]);
  expect(signOutReviewed).toHaveBeenCalledWith(["reviewed"]);
});
it("maps the structured desktop response to a reconfirmation request", async () => {
  const signOutReviewed = vi.fn(async () => ({ status: "changed" as const }));
  window.contextDesktop = { version: 1, platform: "linux", signOutReviewed } as unknown as DesktopBridge;
  const adapter = await createPlatformAdapter({ mobile: false });
  await expect(adapter.native!.signOut([])).rejects.toBeInstanceOf(NativeSignOutReviewRequired);
});
it("rejects incompatible desktop bridges and loads Android only for mobile builds", async () => {
  window.contextDesktop = { version: 2 } as unknown as DesktopBridge;
  await expect(createPlatformAdapter({ mobile: false })).rejects.toThrow("bridge version 2");
  const android = { kind: "android", dispose: vi.fn() } as const;
  const loadAndroid = vi.fn(async () => android);
  expect(await createPlatformAdapter({ mobile: true, loadAndroid })).toBe(android);
});
