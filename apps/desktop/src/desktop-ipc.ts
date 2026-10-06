import { IdSchema } from "@mdc/contracts";
import type { DesktopCommands } from "./commands.js";
import { assertTrustedSender } from "./security.js";

interface FrameLike { url: string }
interface WebContentsLike { mainFrame: FrameLike }
interface WindowLike { webContents: WebContentsLike }
interface InvokeEventLike { sender: unknown; senderFrame?: FrameLike | null }
interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEventLike, ...args: unknown[]) => unknown): void;
}

export function registerRecoveryIpcHandler(
  ipcMain: IpcMainLike,
  options: {
    method: string;
    getWindow(): WindowLike | undefined;
    recoveryUrl: string;
    action(): unknown;
    errorMessage(error: unknown): string;
  },
): void {
  ipcMain.handle(`mdc:${options.method}`, async (event, ...args: unknown[]) => {
    const window = options.getWindow();
    if (!window || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== options.recoveryUrl || args.length)
      return { ok: false, message: "Invalid reconnect request." };
    try { return { ok: true, value: await options.action() }; }
    catch (error) { return { ok: false, message: options.errorMessage(error) }; }
  });
}

export function registerTrustedIpcHandler(
  ipcMain: IpcMainLike,
  options: {
    method: string;
    count: number;
    getWindow(): WindowLike | undefined;
    origin: string;
    errorMessage(error: unknown): string;
    action(...args: unknown[]): unknown;
  },
): void {
  ipcMain.handle(`mdc:${options.method}`, async (event, ...args: unknown[]) => {
    try {
      const window = options.getWindow();
      if (!window || event.sender !== window.webContents)
        throw new Error("Unknown application window.");
      assertTrustedSender(
        event.senderFrame?.url ?? "",
        event.senderFrame === window.webContents.mainFrame,
        options.origin,
      );
      if (args.length !== options.count) throw new Error("Invalid native request.");
      return { ok: true, value: await options.action(...args) };
    } catch (error) {
      return { ok: false, message: options.errorMessage(error) };
    }
  });
}

export function completeCommandAction(commands: Pick<DesktopCommands, "complete">) {
  return (registration: unknown, id: unknown, allow: unknown): Promise<void> => {
    if (typeof allow !== "boolean") throw new Error("Invalid application command response.");
    return commands.complete(IdSchema.parse(registration), IdSchema.parse(id), allow);
  };
}
