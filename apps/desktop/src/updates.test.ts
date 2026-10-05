import { describe, expect, it, vi } from "vitest";
import { NativeUpdateManager, type UpdateBackend } from "./updates.js";
import { updateCatalogFixture } from "./update-test-fixtures.js";

function fixture(overrides: Partial<ConstructorParameters<typeof NativeUpdateManager>[0]> = {}) {
  const catalog = updateCatalogFixture();
  let finishDownload!: () => void;
  const backend: UpdateBackend = {
    prepare: vi.fn(async () => {}),
    download: vi.fn(async (artifact, progress) => {
      progress(artifact.size, artifact.size);
      await new Promise<void>((resolve) => { finishDownload = resolve; });
      return { artifact, path: `/private/${artifact.name}`, identity: "verified" };
    }),
    install: vi.fn(async () => {}),
  };
  const manager = new NativeUpdateManager({
    platform: "darwin",
    arch: "arm64",
    currentVersion: "0.5.4",
    systemVersion: "13.6.0",
    readCatalog: vi.fn(async () => catalog),
    backend,
    ...overrides,
  });
  return { manager, backend, catalog, finishDownload: () => finishDownload() };
}

describe("native update state", () => {
  it("reads idle state and refuses an unprepared install without network access", async () => {
    const readCatalog = vi.fn(async () => updateCatalogFixture());
    const { manager, backend } = fixture({ readCatalog });
    await expect(manager.getUpdateState()).resolves.toMatchObject({ status: "idle", currentVersion: "0.5.4" });
    await expect(manager.installUpdate()).rejects.toThrow(/ready/i);
    expect(readCatalog).not.toHaveBeenCalled();
    expect(backend.prepare).not.toHaveBeenCalled();
  });

  it("coalesces concurrent checks and publishes an available state with zero progress", async () => {
    let release!: () => void;
    const catalog = updateCatalogFixture();
    const readCatalog = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return catalog; });
    const { manager, backend } = fixture({ readCatalog });
    const states: string[] = [];
    manager.onUpdateState(state => states.push(state.status));
    const first = manager.checkForUpdates();
    const second = manager.checkForUpdates();
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toMatchObject({
      status: "available",
      availableVersion: "0.5.5",
      progress: { transferred: 0, total: catalog.artifacts[0]!.size, percent: 0 },
    });
    expect(readCatalog).toHaveBeenCalledOnce();
    expect(backend.prepare).toHaveBeenCalledOnce();
    expect(states).toEqual(["checking", "available"]);
  });

  it("isolates a failed state subscriber from update work", async () => {
    const { manager } = fixture();
    manager.onUpdateState(() => { throw new Error("closed renderer"); });
    await expect(manager.checkForUpdates()).resolves.toMatchObject({ status: "available" });
  });

  it.each(["0.5.5", "0.5.6"])("does not contact a platform feed or downgrade from %s", async currentVersion => {
    const { manager, backend } = fixture({ currentVersion });
    await expect(manager.checkForUpdates()).resolves.toMatchObject({ status: "up-to-date", currentVersion });
    expect(backend.prepare).not.toHaveBeenCalled();
    expect(backend.download).not.toHaveBeenCalled();
  });

  it("rejects the wrong architecture and unsupported operating-system version before platform network access", async () => {
    const wrongArchitecture = fixture({ arch: "x64" });
    await expect(wrongArchitecture.manager.checkForUpdates()).resolves.toMatchObject({ status: "error" });
    expect(wrongArchitecture.backend.prepare).not.toHaveBeenCalled();
    const oldSystem = fixture({ systemVersion: "12.6.9" });
    await expect(oldSystem.manager.checkForUpdates()).resolves.toMatchObject({ status: "error" });
    expect(oldSystem.backend.prepare).not.toHaveBeenCalled();
  });

  it("coalesces downloads, publishes progress, and installs only the verified token", async () => {
    const { manager, backend, finishDownload } = fixture();
    await manager.checkForUpdates();
    const states: string[] = [];
    manager.onUpdateState(state => states.push(state.status));
    const first = manager.startUpdate();
    const second = manager.startUpdate();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(backend.download).toHaveBeenCalledOnce());
    finishDownload();
    await expect(first).resolves.toMatchObject({ status: "ready" });
    expect(manager.isReadyToInstall()).toBe(true);
    await manager.installUpdate();
    expect(backend.install).toHaveBeenCalledWith(expect.objectContaining({ identity: "verified" }));
    expect(states).toContain("downloading");
    expect(states).toContain("ready");
    expect(states).toContain("installing");
    await expect(manager.getUpdateState()).resolves.toMatchObject({
      status: "ready",
      message: expect.stringMatching(/opened|replace/i),
    });
    await expect(manager.startUpdate()).resolves.toMatchObject({ status: "ready" });
    expect(backend.download).toHaveBeenCalledOnce();
  });

  it("does not replace the verified cache while installation is in progress", async () => {
    let finishInstall!: () => void;
    const { manager, backend, finishDownload } = fixture();
    (backend.install as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishInstall = resolve; });
    });
    await manager.checkForUpdates();
    const download = manager.startUpdate();
    await vi.waitFor(() => expect(backend.download).toHaveBeenCalledOnce());
    finishDownload(); await download;
    const install = manager.installUpdate();
    await expect(manager.startUpdate()).resolves.toMatchObject({ status: "installing" });
    expect(backend.download).toHaveBeenCalledOnce();
    finishInstall(); await install;
  });

  it("reports network and download failures without enabling install", async () => {
    const checkFailure = fixture({ readCatalog: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(checkFailure.manager.checkForUpdates()).resolves.toMatchObject({ status: "error" });
    expect(checkFailure.manager.isReadyToInstall()).toBe(false);
    const downloadFailure = fixture();
    (downloadFailure.backend.download as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("bad hash"));
    await downloadFailure.manager.checkForUpdates();
    await expect(downloadFailure.manager.startUpdate()).resolves.toMatchObject({ status: "error" });
    await expect(downloadFailure.manager.installUpdate()).rejects.toThrow(/ready/i);
  });
});
