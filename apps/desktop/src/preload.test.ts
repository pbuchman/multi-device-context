import { afterEach, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@mdc/contracts";

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.expose }, ipcRenderer: electron }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

it("keeps the reviewed sign-out snapshot independent of concurrent inbox reads", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  vi.stubGlobal("location", { origin: "https://app.example.test", protocol: "https:" });
  vi.stubGlobal("MDC_APP_ORIGIN", "https://app.example.test");
  let finishRead!: (value: unknown) => void;
  electron.invoke.mockImplementation(async (method: string) => method === "mdc:getPendingClipboardShares"
    ? new Promise(resolve => { finishRead = resolve; }) : { ok: true, value: undefined });
  await import("./preload.js");
  const bridge = electron.expose.mock.calls[0]![1] as DesktopBridge & { signOut(reviewedIds: readonly string[]): Promise<void> };
  const read = bridge.getPendingClipboardShares();
  finishRead({ ok: true, value: [{ id: "late-unreviewed" }] }); await read;
  await bridge.signOut(["explicitly-reviewed"]);
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:signOut", ["explicitly-reviewed"]);
  await bridge.signOut();
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:signOut", []);
  expect(bridge.version).toBe(1);
  expect(bridge).toMatchObject({ reviewedSignOut: true });
});
