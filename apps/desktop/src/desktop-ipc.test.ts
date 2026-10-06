import { expect, it, vi } from "vitest";
import { completeCommandAction, registerTrustedIpcHandler, registerRecoveryIpcHandler } from "./desktop-ipc.js";

const registration = "00000000-0000-4000-8000-000000000091";
const request = "00000000-0000-4000-8000-000000000092";

function fixture() {
  const mainFrame = { url: "https://app.example.test/context/1" };
  const webContents = { mainFrame };
  const window = { webContents };
  const ipcMain = { handle: vi.fn() };
  const commands = { complete: vi.fn() };
  registerTrustedIpcHandler(ipcMain, {
    method: "completeCommand",
    count: 3,
    getWindow: () => window,
    origin: "https://app.example.test",
    errorMessage: error => error instanceof Error ? error.message : "failed",
    action: completeCommandAction(commands),
  });
  expect(ipcMain.handle).toHaveBeenCalledWith("mdc:completeCommand", expect.any(Function));
  const handler = ipcMain.handle.mock.calls[0]![1];
  const event = { sender: webContents, senderFrame: mainFrame };
  return { commands, event, handler, mainFrame, webContents };
}

it("awaits an asynchronous command completion and returns its rejection through IPC", async () => {
  const value = fixture();
  let rejectCompletion!: (error: Error) => void;
  value.commands.complete.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectCompletion = reject; }));
  let settled = false;
  const response = value.handler(value.event, registration, request, true).then((result: unknown) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  rejectCompletion(new Error("NSIS launch failed"));
  await expect(response).resolves.toEqual({ ok: false, message: "NSIS launch failed" });
  expect(value.commands.complete).toHaveBeenCalledWith(registration, request, true);
});

it("retains trusted sender, main-frame, origin, argument and command validation", async () => {
  const value = fixture();
  value.commands.complete.mockResolvedValue(undefined);
  const invalid = [
    [{ ...value.event, sender: {} }, [registration, request, true]],
    [{ ...value.event, senderFrame: { url: value.mainFrame.url } }, [registration, request, true]],
    [{ ...value.event, senderFrame: { ...value.mainFrame, url: "https://evil.example.test" } }, [registration, request, true]],
    [value.event, [registration, request]],
    [value.event, [registration, request, "yes"]],
    [value.event, ["invalid", request, true]],
  ] as const;
  for (const [event, args] of invalid) {
    const response = await value.handler(event, ...args);
    expect(response).toMatchObject({ ok: false });
  }
  expect(value.commands.complete).not.toHaveBeenCalled();
  await expect(value.handler(value.event, registration, request, false)).resolves.toEqual({ ok: true, value: undefined });
  expect(value.commands.complete).toHaveBeenCalledWith(registration, request, false);
});

function recoveryFixture() {
  const recoveryUrl = "file:///app/recovery.html";
  const mainFrame = { url: recoveryUrl };
  const webContents = { mainFrame };
  const ipcMain = { handle: vi.fn() };
  const action = vi.fn();
  registerRecoveryIpcHandler(ipcMain, {
    method: "retry", getWindow: () => ({ webContents }), recoveryUrl, action,
    errorMessage: error => error instanceof Error ? error.message : "failed",
  });
  expect(ipcMain.handle).toHaveBeenCalledWith("mdc:retry", expect.any(Function));
  return { action, mainFrame, handler: ipcMain.handle.mock.calls[0]![1], event: { sender: webContents, senderFrame: mainFrame } };
}

it("allows recovery diagnostics only from the exact owned recovery main frame", async () => {
  const value = recoveryFixture();
  value.action.mockResolvedValue({ code: "ERR_CERT_AUTHORITY_INVALID" });
  for (const url of ["file:///other/recovery.html", "file:///app/recovery.html?x=1", "file:///app/recovery.html#x", "https://app.example.test"]) {
    value.mainFrame.url = url;
    await expect(value.handler(value.event)).resolves.toEqual({ ok: false, message: "Invalid reconnect request." });
  }
  value.mainFrame.url = "file:///app/recovery.html";
  await expect(value.handler({ ...value.event, sender: {} })).resolves.toMatchObject({ ok: false });
  await expect(value.handler({ ...value.event, senderFrame: { ...value.mainFrame } })).resolves.toMatchObject({ ok: false });
  await expect(value.handler(value.event, "unexpected")).resolves.toMatchObject({ ok: false });
  expect(value.action).not.toHaveBeenCalled();
  await expect(value.handler(value.event)).resolves.toEqual({ ok: true, value: { code: "ERR_CERT_AUTHORITY_INVALID" } });
});

it("returns a failed asynchronous reconnect as failure instead of success", async () => {
  const value = recoveryFixture();
  value.action.mockRejectedValue(new Error("The secure connection certificate could not be verified."));
  await expect(value.handler(value.event)).resolves.toEqual({ ok: false, message: "The secure connection certificate could not be verified." });
});
