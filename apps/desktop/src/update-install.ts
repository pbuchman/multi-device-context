import type { DesktopCommands } from "./commands.js";

interface InstallableUpdate {
  isReadyToInstall(): boolean;
  installUpdate(): Promise<void>;
}

export async function installDesktopUpdate(
  platform: "darwin" | "win32",
  commands: Pick<DesktopCommands, "request">,
  updates: InstallableUpdate,
): Promise<void> {
  if (!updates.isReadyToInstall()) throw new Error("The update is not ready to install.");
  if (platform === "darwin") {
    await updates.installUpdate();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const accepted = commands.request("quit", async allow => {
      if (!allow) {
        reject(new Error("Update installation was cancelled before local changes were saved."));
        return;
      }
      try {
        await updates.installUpdate();
        resolve();
      } catch (error) {
        reject(error);
        throw error;
      }
    });
    if (!accepted) reject(new Error("Another application action is still waiting to finish."));
  });
}
