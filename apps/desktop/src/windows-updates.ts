import type { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, join } from "node:path";
import { CancellationToken, type ProgressInfo, type UpdateCheckResult, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";
import { MAX_UPDATE_ARTIFACT_BYTES, type WindowsUpdateArtifact } from "@mdc/contracts";
import {
  reverifyDownloadedArtifactForInstall,
  verifyDownloadedArtifact,
  type DesktopUpdateArtifact,
  type VerifiedUpdate,
} from "./update-files.js";
import type { UpdateBackend } from "./updates.js";
import { UpdateHandoffError } from "./update-errors.js";

export interface WindowsUpdater extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall?: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  disableDifferentialDownload: boolean;
  requestHeaders: Record<string, string> | null;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(cancellationToken?: CancellationToken): Promise<string[]>;
}

export interface WindowsInstallerLauncher {
  launch(installerPath: string): Promise<void>;
}

interface AwaitedWindowsInstallerOptions {
  resourcesPath: string;
  beforeQuitForUpdate(): void;
  quit(): void;
  spawn?: typeof spawn;
  scheduleQuit?: (task: () => void) => void;
}

function spawnAcknowledged(
  spawnProcess: typeof spawn,
  command: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, args, { detached: true, shell: false, stdio: "ignore" });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function launchErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

// electron-updater 6.8.9's NsisUpdater returns from doInstall before its
// detached spawn can fail, while BaseUpdater schedules app.quit immediately.
// Keep its feed/download cache, but await a fixed silent NSIS update launch here.
export class AwaitedWindowsInstaller implements WindowsInstallerLauncher {
  readonly #options: AwaitedWindowsInstallerOptions;

  constructor(options: AwaitedWindowsInstallerOptions) {
    this.#options = options;
  }

  async launch(installerPath: string): Promise<void> {
    const args = ["--updated", "/S", "--force-run"];
    const spawnProcess = this.#options.spawn ?? spawn;
    try {
      await spawnAcknowledged(spawnProcess, installerPath, args);
    } catch (error) {
      const code = launchErrorCode(error);
      if (code === "UNKNOWN" || code === "EACCES") {
        await spawnAcknowledged(
          spawnProcess,
          join(this.#options.resourcesPath, "elevate.exe"),
          [installerPath, ...args],
        );
      } else {
        throw error;
      }
    }
    (this.#options.scheduleQuit ?? setImmediate)(() => {
      this.#options.beforeQuitForUpdate();
      this.#options.quit();
    });
  }
}

function windowsArtifact(artifact: DesktopUpdateArtifact): WindowsUpdateArtifact {
  if (artifact.platform !== "win32") throw new Error("Windows updater received the wrong platform artifact.");
  return artifact;
}

export function validateWindowsUpdateInfo(
  info: UpdateInfo,
  artifact: WindowsUpdateArtifact,
  version: string,
): void {
  const file = info.files?.[0];
  const packages = (info as UpdateInfo & { packages?: unknown }).packages;
  const fileKeys = file ? Object.keys(file).sort().join(",") : "";
  if (
    info.version !== version ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    artifact.size > MAX_UPDATE_ARTIFACT_BYTES ||
    info.files?.length !== 1 ||
    !file ||
    fileKeys !== "sha512,size,url" ||
    file.url !== artifact.url ||
    file.size !== artifact.size ||
    file.sha512 !== artifact.sha512 ||
    info.path !== artifact.url ||
    info.sha512 !== artifact.sha512 ||
    packages != null
  ) throw new Error("Windows update metadata does not match the catalog selection.");
}

export class WindowsUpdateBackend implements UpdateBackend {
  readonly #updater: WindowsUpdater;
  readonly #installer: WindowsInstallerLauncher;
  readonly #downloadTimeoutMs: number;
  #artifact: WindowsUpdateArtifact | undefined;
  #version: string | undefined;

  constructor(
    updater: WindowsUpdater,
    installer: WindowsInstallerLauncher,
    downloadTimeoutMs = 15 * 60_000,
  ) {
    this.#updater = updater;
    this.#installer = installer;
    if (!Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs <= 0)
      throw new Error("Invalid Windows update download deadline.");
    this.#downloadTimeoutMs = downloadTimeoutMs;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    updater.requestHeaders = null;
    // EventEmitter throws an otherwise unhandled "error" event. Operations
    // still reject through electron-updater's promises and become safe UI state.
    updater.on("error", () => {});
  }

  async prepare(value: DesktopUpdateArtifact, version: string): Promise<void> {
    const artifact = windowsArtifact(value);
    const result = await this.#updater.checkForUpdates();
    if (!result?.isUpdateAvailable)
      throw new Error("Windows feed did not offer the catalog-selected update.");
    validateWindowsUpdateInfo(result.updateInfo, artifact, version);
    this.#artifact = artifact;
    this.#version = version;
  }

  async download(
    value: DesktopUpdateArtifact,
    progress: (transferred: number, total: number) => void,
  ): Promise<VerifiedUpdate> {
    const artifact = windowsArtifact(value);
    if (!this.#artifact || this.#artifact.url !== artifact.url || !this.#version)
      throw new Error("Windows update metadata must be checked before download.");
    let downloaded: UpdateDownloadedEvent | undefined;
    let cancelled = false;
    let downloadFailure: Error | undefined;
    const cancellation = new CancellationToken();
    const onProgress = (progressInfo: ProgressInfo) => {
      if (
        !Number.isSafeInteger(progressInfo.transferred) ||
        !Number.isSafeInteger(progressInfo.total) ||
        progressInfo.transferred < 0 ||
        progressInfo.total !== artifact.size ||
        progressInfo.transferred > artifact.size ||
        progressInfo.transferred > MAX_UPDATE_ARTIFACT_BYTES
      ) {
        downloadFailure = new Error("Windows update download progress exceeded the selected size.");
        cancellation.cancel();
        return;
      }
      progress(progressInfo.transferred, progressInfo.total);
    };
    const onDownloaded = (event: UpdateDownloadedEvent) => { downloaded = event; };
    const onCancelled = () => { cancelled = true; };
    this.#updater.on("download-progress", onProgress);
    this.#updater.on("update-downloaded", onDownloaded);
    this.#updater.on("update-cancelled", onCancelled);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          downloadFailure = new Error("Windows update download timed out.");
          cancellation.cancel();
          reject(downloadFailure);
        }, this.#downloadTimeoutMs);
      });
      const paths = await Promise.race([this.#updater.downloadUpdate(cancellation), timeout]);
      if (downloadFailure) throw downloadFailure;
      if (cancelled) throw new Error("Windows update download was cancelled.");
      if (paths.length !== 1 || !downloaded || paths[0] !== downloaded.downloadedFile)
        throw new Error("Windows updater returned an unexpected cached installer.");
      validateWindowsUpdateInfo(downloaded, artifact, this.#version);
      if (basename(paths[0]!) !== artifact.name)
        throw new Error("Windows updater cached an unexpected installer name.");
      return await verifyDownloadedArtifact(paths[0]!, artifact);
    } finally {
      if (deadline) clearTimeout(deadline);
      this.#updater.off("download-progress", onProgress);
      this.#updater.off("update-downloaded", onDownloaded);
      this.#updater.off("update-cancelled", onCancelled);
    }
  }

  async install(verified: VerifiedUpdate): Promise<void> {
    if (verified.artifact.platform !== "win32" || !this.#artifact || verified.artifact.url !== this.#artifact.url)
      throw new Error("The cached Windows update is no longer selected.");
    const path = await reverifyDownloadedArtifactForInstall(verified);
    try {
      await this.#installer.launch(path);
    } catch (error) {
      await reverifyDownloadedArtifactForInstall(verified);
      throw new UpdateHandoffError("Windows could not start the verified update installer.", error);
    }
  }
}
