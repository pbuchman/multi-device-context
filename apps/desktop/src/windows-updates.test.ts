import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CancellationToken, UpdateInfo } from "electron-updater";
import { NsisUpdater } from "electron-updater";
import {
  AwaitedWindowsInstaller,
  WindowsUpdateBackend,
  validateWindowsUpdateInfo,
  type WindowsInstallerLauncher,
  type WindowsUpdater,
} from "./windows-updates.js";
import { windowsUpdateFixture } from "./update-test-fixtures.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));
async function downloadedInstaller() {
  const bytes = Buffer.from("verified desktop installer");
  const artifact = windowsUpdateFixture("0.5.5", bytes);
  const directory = await mkdtemp(join(tmpdir(), "mdc-windows-update-"));
  directories.push(directory);
  const path = join(directory, artifact.name);
  await writeFile(path, bytes);
  return { artifact, path };
}
function updateInfo(artifact: Awaited<ReturnType<typeof downloadedInstaller>>["artifact"]): UpdateInfo {
  return {
    version: "0.5.5",
    files: [{ url: artifact.url, sha512: artifact.sha512, size: artifact.size }],
    path: artifact.url,
    sha512: artifact.sha512,
    releaseDate: "2026-10-05T00:00:00.000Z",
  };
}
function updaterFixture(info: ReturnType<typeof updateInfo>, path: string) {
  const emitter = new EventEmitter() as WindowsUpdater;
  Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    disableDifferentialDownload: false,
    requestHeaders: { authorization: "secret" },
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: info })),
    downloadUpdate: vi.fn(async () => {
      emitter.emit("download-progress", { transferred: info.files[0]!.size, total: info.files[0]!.size, percent: 100 });
      emitter.emit("update-downloaded", { ...info, downloadedFile: path });
      return [path];
    }),
  });
  return emitter;
}
function installerFixture(): WindowsInstallerLauncher & { launch: ReturnType<typeof vi.fn> } {
  return { launch: vi.fn(async () => {}) };
}

describe("Windows NSIS metadata", () => {
  it("accepts only the catalog-selected version, URL, size and SHA-512 metadata", async () => {
    const { artifact } = await downloadedInstaller();
    expect(() => validateWindowsUpdateInfo(updateInfo(artifact), artifact, "0.5.5")).not.toThrow();
    for (const changed of [
      { version: "0.5.6" },
      { files: [{ ...updateInfo(artifact).files[0], url: "https://attacker.example/setup.exe" }] },
      { files: [{ ...updateInfo(artifact).files[0], size: artifact.size + 1 }] },
      { files: [{ ...updateInfo(artifact).files[0], sha512: "A".repeat(86) + "==" }] },
      { files: [{ ...updateInfo(artifact).files[0], isAdminRightsRequired: true }] },
      { packages: { x64: { path: "web.7z", sha512: artifact.sha512 } } },
    ]) {
      expect(() => validateWindowsUpdateInfo({ ...updateInfo(artifact), ...changed } as UpdateInfo, artifact, "0.5.5")).toThrow(/metadata/i);
    }
  });

  it("disables automatic download/install, downgrade, auth and web installers", async () => {
    const { artifact, path } = await downloadedInstaller();
    const updater = updaterFixture(updateInfo(artifact), path);
    new WindowsUpdateBackend(updater, installerFixture());
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
      disableDifferentialDownload: true,
      requestHeaders: null,
    });
  });

  it("does not arm electron-updater's ordinary-quit install handler", () => {
    class InspectedNsisUpdater extends NsisUpdater {
      inspectQuitHandler() { this.addQuitHandler(); }
    }
    const onQuit = vi.fn();
    const app = {
      version: "0.5.4", name: "Multi Device Context", isPackaged: true,
      appUpdateConfigPath: "unused", userDataPath: "unused", baseCachePath: "unused",
      whenReady: async () => {}, relaunch: vi.fn(), quit: vi.fn(), onQuit,
    };
    const updater = new InspectedNsisUpdater(null, app);
    new WindowsUpdateBackend(updater as unknown as WindowsUpdater, installerFixture());
    expect(updater.channel).toBeNull();
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    updater.inspectQuitHandler();
    expect(onQuit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("cross-checks the fixed feed before download and re-verifies before explicit install", async () => {
    const { artifact, path } = await downloadedInstaller();
    const updater = updaterFixture(updateInfo(artifact), path);
    const installer = installerFixture();
    const backend = new WindowsUpdateBackend(updater, installer);
    await backend.prepare(artifact, "0.5.5");
    const verified = await backend.download(artifact, vi.fn());
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    await backend.install(verified);
    expect(installer.launch).toHaveBeenCalledWith(verified.path);
  });

  it("never invokes NSIS when the verified cache changes after download", async () => {
    const { artifact, path } = await downloadedInstaller();
    const updater = updaterFixture(updateInfo(artifact), path);
    const installer = installerFixture();
    const backend = new WindowsUpdateBackend(updater, installer);
    await backend.prepare(artifact, "0.5.5");
    const verified = await backend.download(artifact, vi.fn());
    await writeFile(path, "tampered");
    await expect(backend.install(verified)).rejects.toThrow(/changed|size|checksum/i);
    expect(installer.launch).not.toHaveBeenCalled();
  });

  it("awaits an installer launch failure instead of closing the application", async () => {
    const { artifact, path } = await downloadedInstaller();
    const updater = updaterFixture(updateInfo(artifact), path);
    const installer = installerFixture();
    const backend = new WindowsUpdateBackend(updater, installer);
    await backend.prepare(artifact, "0.5.5");
    const verified = await backend.download(artifact, vi.fn());
    installer.launch.mockRejectedValueOnce(new Error("NSIS launch failed"));
    await expect(backend.install(verified)).rejects.toThrow(/NSIS launch failed/i);
  });

  it("treats a cancelled updater download as unusable", async () => {
    const { artifact, path } = await downloadedInstaller();
    const updater = updaterFixture(updateInfo(artifact), path);
    (updater.downloadUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      updater.emit("update-cancelled", updateInfo(artifact));
      return [path];
    });
    const installer = installerFixture();
    const backend = new WindowsUpdateBackend(updater, installer);
    await backend.prepare(artifact, "0.5.5");
    await expect(backend.download(artifact, vi.fn())).rejects.toThrow(/cancelled/i);
    expect(installer.launch).not.toHaveBeenCalled();
  });

  it("cancels download progress that exceeds or disagrees with the selected artifact", async () => {
    const { artifact, path } = await downloadedInstaller();
    const updater = updaterFixture(updateInfo(artifact), path);
    let token: CancellationToken | undefined;
    (updater.downloadUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce(async (value: CancellationToken) => {
      token = value;
      updater.emit("download-progress", {
        transferred: artifact.size + 1,
        total: artifact.size,
        percent: 100,
      });
      return [path];
    });
    const installer = installerFixture();
    const backend = new WindowsUpdateBackend(updater, installer);
    await backend.prepare(artifact, "0.5.5");
    await expect(backend.download(artifact, vi.fn())).rejects.toThrow(/size|progress/i);
    expect(token?.cancelled).toBe(true);
    expect(installer.launch).not.toHaveBeenCalled();
  });

  it("cancels a stalled updater download at the fixed deadline", async () => {
    const { artifact, path } = await downloadedInstaller();
    const updater = updaterFixture(updateInfo(artifact), path);
    let token: CancellationToken | undefined;
    (updater.downloadUpdate as ReturnType<typeof vi.fn>).mockImplementationOnce((value: CancellationToken) => {
      token = value;
      return new Promise<string[]>(() => {});
    });
    const installer = installerFixture();
    const backend = new WindowsUpdateBackend(updater, installer, 5);
    await backend.prepare(artifact, "0.5.5");
    await expect(backend.download(artifact, vi.fn())).rejects.toThrow(/timed out/i);
    expect(token?.cancelled).toBe(true);
    expect(installer.launch).not.toHaveBeenCalled();
  });

});

type SpawnedChild = ChildProcess & EventEmitter & { unref: ReturnType<typeof vi.fn> };
function spawnFixture() {
  const children: SpawnedChild[] = [];
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as SpawnedChild;
    child.unref = vi.fn<() => void>(() => {});
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, children };
}
function launchFixture() {
  const { spawn, children } = spawnFixture();
  const events: string[] = [];
  const scheduled: Array<() => void> = [];
  const openPath = vi.fn(async () => "");
  const launcher = new AwaitedWindowsInstaller({
    resourcesPath: "C:\\Program Files\\Multi Device Context\\resources",
    spawn,
    openPath,
    beforeQuitForUpdate: () => { events.push("before-quit-for-update"); },
    quit: () => { events.push("quit"); },
    scheduleQuit: task => { scheduled.push(task); },
  });
  return { launcher, children, events, scheduled, openPath, spawn };
}
function launchError(code: string, message = "launch failed"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("awaited Windows NSIS launch", () => {
  it("waits for the OS spawn acknowledgement before scheduling the update quit", async () => {
    const fixture = launchFixture();
    const launched = fixture.launcher.launch("C:\\cache\\selected-setup.exe");
    expect(fixture.spawn).toHaveBeenCalledWith(
      "C:\\cache\\selected-setup.exe",
      ["--updated", "--force-run"],
      { detached: true, shell: false, stdio: "ignore" },
    );
    expect(fixture.scheduled).toHaveLength(0);
    fixture.children[0]!.emit("spawn");
    await launched;
    expect(fixture.children[0]!.unref).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual([]);
    expect(fixture.scheduled).toHaveLength(1);
    fixture.scheduled[0]!();
    expect(fixture.events).toEqual(["before-quit-for-update", "quit"]);
  });

  it("rejects a deferred spawn failure without scheduling application quit", async () => {
    const fixture = launchFixture();
    const launched = fixture.launcher.launch("C:\\cache\\selected-setup.exe");
    fixture.children[0]!.emit("error", launchError("ENOEXEC"));
    await expect(launched).rejects.toThrow(/launch failed/i);
    expect(fixture.scheduled).toHaveLength(0);
    expect(fixture.events).toEqual([]);
  });

  it("awaits the fixed elevate helper fallback and rejects its deferred failure", async () => {
    const fixture = launchFixture();
    const launched = fixture.launcher.launch("C:\\cache\\selected-setup.exe");
    fixture.children[0]!.emit("error", launchError("EACCES"));
    await vi.waitFor(() => expect(fixture.children).toHaveLength(2));
    expect(fixture.spawn).toHaveBeenLastCalledWith(
      join("C:\\Program Files\\Multi Device Context\\resources", "elevate.exe"),
      ["C:\\cache\\selected-setup.exe", "--updated", "--force-run"],
      { detached: true, shell: false, stdio: "ignore" },
    );
    fixture.children[1]!.emit("error", launchError("EACCES", "elevation failed"));
    await expect(launched).rejects.toThrow(/elevation failed/i);
    expect(fixture.scheduled).toHaveLength(0);
  });

  it("awaits the shell fallback and rejects its asynchronous error result", async () => {
    const fixture = launchFixture();
    fixture.openPath.mockResolvedValueOnce("The system refused the installer");
    const launched = fixture.launcher.launch("C:\\cache\\selected-setup.exe");
    fixture.children[0]!.emit("error", launchError("ENOENT"));
    await expect(launched).rejects.toThrow(/system refused/i);
    expect(fixture.openPath).toHaveBeenCalledWith("C:\\cache\\selected-setup.exe");
    expect(fixture.scheduled).toHaveLength(0);
  });
});
