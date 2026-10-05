import type { EventEmitter } from "node:events";
import { basename } from "node:path";
import { CancellationToken, type ProgressInfo, type UpdateCheckResult, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";
import { MAX_UPDATE_ARTIFACT_BYTES, type WindowsUpdateArtifact } from "@mdc/contracts";
import {
  reverifyDownloadedArtifact,
  verifyDownloadedArtifact,
  type DesktopUpdateArtifact,
  type VerifiedUpdate,
} from "./update-files.js";
import type { UpdateBackend } from "./updates.js";

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
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
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
  readonly #downloadTimeoutMs: number;
  #artifact: WindowsUpdateArtifact | undefined;
  #version: string | undefined;

  constructor(updater: WindowsUpdater, downloadTimeoutMs = 15 * 60_000) {
    this.#updater = updater;
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
    await reverifyDownloadedArtifact(verified);
    let installError: Error | undefined;
    const onError = (error: unknown) => {
      installError = error instanceof Error ? error : new Error("Windows updater could not start the installer.");
    };
    this.#updater.on("error", onError);
    try {
      this.#updater.quitAndInstall(false, true);
      if (installError) throw installError;
    } finally {
      this.#updater.off("error", onError);
    }
  }
}
