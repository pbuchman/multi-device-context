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
  await bridge.getAccountProfile!();
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:getAccountProfile");
  await bridge.getAccountAvatar!();
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:getAccountAvatar");
  expect(bridge.version).toBe(1);
  expect(bridge).toMatchObject({ reviewedSignOut: true });
});

it("subscribes trusted commands without exposing IPC and unregisters readiness", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  vi.stubGlobal("location", { origin: "https://app.example.test", protocol: "https:" });
  vi.stubGlobal("MDC_APP_ORIGIN", "https://app.example.test");
  electron.invoke.mockResolvedValue({ ok: true, value: undefined });
  await import("./preload.js"); const bridge = electron.expose.mock.calls[0]![1] as DesktopBridge;
  const listener = vi.fn(); const unsubscribe = bridge.onCommand!(listener);
  const registration = electron.invoke.mock.calls.find(call => call[0] === "mdc:commandSubscription")![1];
  expect(electron.invoke).toHaveBeenCalledWith("mdc:commandSubscription", registration, true);
  const notify = electron.on.mock.calls.find(call => call[0] === "mdc:command")![1];
  const request = { id: "00000000-0000-4000-8000-000000000099", command: "reload" };
  notify({ secretEvent: true }, request); expect(listener).toHaveBeenCalledWith(request);
  notify({}, { id: "bad", command: "reload" }); notify({}, { ...request, command: "execute" }); expect(listener).toHaveBeenCalledTimes(1);
  await bridge.completeCommand!(request.id, false);
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:completeCommand", registration, request.id, false);
  unsubscribe(); notify({}, request); expect(listener).toHaveBeenCalledTimes(1);
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:commandSubscription", registration, false);
  await expect(bridge.completeCommand!(request.id, true)).rejects.toThrow("expired");
});

it("rejects command completion when the trusted main IPC handler reports an async failure", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  vi.stubGlobal("location", { origin: "https://app.example.test", protocol: "https:" });
  vi.stubGlobal("MDC_APP_ORIGIN", "https://app.example.test");
  electron.invoke.mockImplementation(async (method: string) => method === "mdc:completeCommand"
    ? { ok: false, message: "NSIS launch failed" }
    : { ok: true, value: undefined });
  await import("./preload.js");
  const bridge = electron.expose.mock.calls[0]![1] as DesktopBridge;
  bridge.onCommand!(() => {});
  await expect(bridge.completeCommand!("00000000-0000-4000-8000-000000000099", true)).rejects.toThrow("NSIS launch failed");
  expect(electron.invoke).toHaveBeenLastCalledWith(
    "mdc:completeCommand",
    expect.stringMatching(/^[0-9a-f-]{36}$/i),
    "00000000-0000-4000-8000-000000000099",
    true,
  );
});

it("validates update states, exposes parameterless update actions, and unsubscribes", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true, platform: "win32" });
  vi.stubGlobal("location", { origin: "https://app.example.test", protocol: "https:" });
  vi.stubGlobal("MDC_APP_ORIGIN", "https://app.example.test");
  electron.invoke.mockResolvedValue({ ok: true, value: undefined });
  await import("./preload.js");
  const bridge = electron.expose.mock.calls[0]![1] as DesktopBridge;
  await bridge.getUpdateState!();
  await bridge.checkForUpdates!();
  await bridge.startUpdate!();
  await bridge.installUpdate!();
  expect(electron.invoke.mock.calls.slice(-4)).toEqual([
    ["mdc:getUpdateState"],
    ["mdc:checkForUpdates"],
    ["mdc:startUpdate"],
    ["mdc:installUpdate"],
  ]);
  const listener = vi.fn();
  const unsubscribe = bridge.onUpdateState!(listener);
  const notify = electron.on.mock.calls.find(call => call[0] === "mdc:updateState")![1];
  const valid = { status: "available", platform: "win32", currentVersion: "0.5.4", availableVersion: "0.5.5", progress: { transferred: 0, total: 24, percent: 0 } };
  notify({}, valid);
  notify({}, { ...valid, platform: "linux" });
  notify({}, { ...valid, progress: { transferred: 25, total: 24, percent: 101 } });
  expect(listener).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledWith(valid);
  unsubscribe(); notify({}, valid);
  expect(listener).toHaveBeenCalledOnce();
  expect(electron.removeListener).toHaveBeenCalledWith("mdc:updateState", notify);
});

it("exposes only the recovery bridge to a file document", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: true });
  vi.stubGlobal("location", { origin: "null", protocol: "file:" });
  vi.stubGlobal("MDC_APP_ORIGIN", "https://app.example.test");
  const diagnostic = {
    stage: "workspace",
    code: "ERR_CERT_AUTHORITY_INVALID",
    message: "The secure connection certificate could not be verified.",
    occurredAt: "2026-10-06T10:00:00.000Z",
    appVersion: "0.5.5",
  };
  electron.invoke.mockImplementation(async (method: string) => ({
    ok: true,
    value: method === "mdc:getConnectionDiagnostic" ? diagnostic : undefined,
  }));

  await import("./preload.js");
  expect(electron.expose).toHaveBeenCalledTimes(1);
  expect(electron.expose.mock.calls[0]![0]).toBe("contextRecovery");
  const bridge = electron.expose.mock.calls[0]![1] as {
    retry(): Promise<void>;
    getConnectionDiagnostic(): Promise<typeof diagnostic>;
  };
  await expect(bridge.getConnectionDiagnostic()).resolves.toEqual(diagnostic);
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:getConnectionDiagnostic");
  await bridge.retry();
  expect(electron.invoke).toHaveBeenLastCalledWith("mdc:retry");
});
