import { expect, it, vi } from "vitest";
import { DesktopCommands } from "./commands.js";
import { installDesktopUpdate } from "./update-install.js";

function fixture(platform: "darwin" | "win32") {
  const actions = { send: vi.fn(), newChat: vi.fn(), reload: vi.fn(), quit: vi.fn(), changed: vi.fn() };
  const commands = new DesktopCommands(actions);
  const updates = { isReadyToInstall: vi.fn(() => true), installUpdate: vi.fn(async () => {}) };
  return { platform, actions, commands, updates };
}

it("opens a verified macOS update without requesting a terminal quit", async () => {
  const value = fixture("darwin");
  value.commands.subscribe("registration");
  await installDesktopUpdate(value.platform, value.commands, value.updates);
  expect(value.updates.installUpdate).toHaveBeenCalledOnce();
  expect(value.actions.send).not.toHaveBeenCalled();
});

it("waits for the Windows save acknowledgement and rejects both callers on install failure", async () => {
  const value = fixture("win32");
  value.commands.subscribe("registration");
  value.updates.installUpdate.mockRejectedValueOnce(new Error("NSIS failed"));
  const install = installDesktopUpdate(value.platform, value.commands, value.updates);
  const request = value.actions.send.mock.lastCall![0];
  const acknowledgement = value.commands.complete("registration", request.id, true);
  await expect(acknowledgement).rejects.toThrow("NSIS failed");
  await expect(install).rejects.toThrow("NSIS failed");
  expect(value.actions.quit).not.toHaveBeenCalled();
});
