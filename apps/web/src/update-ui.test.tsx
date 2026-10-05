// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateState } from "@mdc/contracts";

import { HostedUpdateNotice, UpdateSettings, useUpdateController, type UpdateController } from "./update-ui.js";
import type { NativeUpdateClient } from "./updates.js";

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const idle = (): UpdateState => ({ status: "idle", platform: "darwin", currentVersion: "1.0.0" });
const ready = (platform: "darwin" | "win32" | "android" = "darwin"): UpdateState => ({
  status: "ready", platform, currentVersion: "1.0.0", availableVersion: "1.1.0",
  progress: { transferred: 2048, total: 2048, percent: 100 },
});

function nativeClient(overrides: Partial<NativeUpdateClient> = {}) {
  let listener: ((state: UpdateState) => void) | undefined;
  const value: NativeUpdateClient = {
    getUpdateState: vi.fn(async () => idle()), checkForUpdates: vi.fn(async () => idle()),
    startUpdate: vi.fn(async () => ready()), installUpdate: vi.fn(async () => undefined),
    onUpdateState: vi.fn(), subscribe: vi.fn(next => { listener = next; return () => { listener = undefined; }; }),
    ...overrides,
  };
  return { value, emit: (state: UpdateState) => listener?.(state) };
}

function options(nativeUpdates: NativeUpdateClient, scope: unknown = nativeUpdates) {
  return {
    platformKind: "desktop" as const, nativeUpdates,
    settle: vi.fn(async () => undefined), freeze: vi.fn(), reload: vi.fn(),
    current: () => true, canInstall: () => true, scope,
  };
}

it("does not let a delayed initial read overwrite a newer subscription event", async () => {
  const initial = deferred<UpdateState>();
  const native = nativeClient({ getUpdateState: () => initial.promise });
  const view = renderHook(() => useUpdateController(options(native.value)));
  act(() => native.emit({ status: "downloading", platform: "darwin", currentVersion: "1.0.0", availableVersion: "1.1.0", progress: { transferred: 100, total: 2048, percent: 5 } }));
  await act(async () => initial.resolve(idle()));
  expect(view.result.current.nativeState?.status).toBe("downloading");
});

it("does not restore ready after install emits a newer error", async () => {
  const native = nativeClient();
  native.value.installUpdate = vi.fn(async () => native.emit({ status: "error", platform: "darwin", currentVersion: "1.0.0", availableVersion: "1.1.0", message: "Installer refused" }));
  const view = renderHook(() => useUpdateController(options(native.value)));
  await act(async () => view.result.current.updateNative());
  expect(view.result.current.nativeState).toMatchObject({ status: "error", message: "Installer refused" });
});

it("does not restore an old ready result after a newer event arrives", async () => {
  const download = deferred<UpdateState>();
  const installUpdate = vi.fn(async () => undefined);
  const native = nativeClient({ startUpdate: () => download.promise, installUpdate });
  const view = renderHook(() => useUpdateController(options(native.value)));
  let operation!: Promise<void>;
  act(() => { operation = view.result.current.updateNative(); });
  act(() => native.emit({ status: "error", platform: "darwin", currentVersion: "1.0.0", availableVersion: "1.1.0", message: "Verification failed" }));
  await act(async () => download.resolve(ready()));
  await operation;
  expect(view.result.current.nativeState).toMatchObject({ status: "error", message: "Verification failed" });
  expect(installUpdate).not.toHaveBeenCalled();
});

it("does not install after unmount or session replacement during download", async () => {
  for (const replacement of [false, true]) {
    const download = deferred<UpdateState>();
    const first = nativeClient({ startUpdate: () => download.promise, installUpdate: vi.fn(async () => undefined) });
    const second = nativeClient();
    const firstScope = {};
    const view = renderHook(({ native, scope }) => useUpdateController(options(native, scope)), { initialProps: { native: first.value, scope: firstScope } });
    let operation!: Promise<void>;
    act(() => { operation = view.result.current.updateNative(); });
    if (replacement) view.rerender({ native: second.value, scope: {} }); else view.unmount();
    await act(async () => download.resolve(ready()));
    await operation;
    expect(first.value.installUpdate).not.toHaveBeenCalled();
    if (replacement) view.unmount();
  }
});

it("invalidates pending work when the workspace changes but the native bridge is reused", async () => {
  const download = deferred<UpdateState>();
  const native = nativeClient({ startUpdate: () => download.promise, installUpdate: vi.fn(async () => undefined) });
  const view = renderHook(({ scope }) => useUpdateController(options(native.value, scope)), { initialProps: { scope: {} } });
  let operation!: Promise<void>;
  act(() => { operation = view.result.current.updateNative(); });
  view.rerender({ scope: {} });
  await act(async () => download.resolve(ready()));
  await operation;
  expect(native.value.installUpdate).not.toHaveBeenCalled();
  expect(view.result.current.updating).toBe(false);
});

it("keeps native download, install, and background error states visible outside Settings", () => {
  const base = { uiBuild: "dev", checking: false, updating: true, check: vi.fn(), updateNative: vi.fn(), reloadHosted: vi.fn() } satisfies UpdateController;
  const { rerender } = render(<HostedUpdateNotice updates={{ ...base, nativeState: { status: "downloading", platform: "win32", currentVersion: "1.0.0", availableVersion: "1.1.0", progress: { transferred: 1024, total: 2048, percent: 50 } } }} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  rerender(<HostedUpdateNotice updates={{ ...base, nativeState: { status: "installing", platform: "win32", currentVersion: "1.0.0", availableVersion: "1.1.0", progress: { transferred: 2048, total: 2048, percent: 100 } } }} />);
  expect(screen.getByText(/Installing native version 1.1.0/)).toBeTruthy();
  rerender(<HostedUpdateNotice updates={{ ...base, updating: false, nativeState: { ...ready(), message: "The DMG is open. Replace the app when convenient." } }} />);
  expect(screen.getByText(/DMG is open/)).toBeTruthy();
  rerender(<HostedUpdateNotice updates={{ ...base, updating: false, nativeState: { status: "error", platform: "win32", currentVersion: "1.0.0", availableVersion: "1.1.0", message: "Background check failed" } }} />);
  expect(screen.getByRole("alert").textContent).toContain("Background check failed");
  expect(screen.getByRole("button", { name: "Retry update" })).toBeTruthy();
});

it("keeps a command rejection visible and retryable outside Settings", () => {
  const retry = vi.fn();
  render(<HostedUpdateNotice updates={{
    uiBuild: "dev", checking: false, updating: false, check: vi.fn(), updateNative: retry, reloadHosted: vi.fn(),
    nativeState: { status: "downloading", platform: "darwin", currentVersion: "1.0.0", availableVersion: "1.1.0", progress: { transferred: 1024, total: 2048, percent: 50 } },
    error: "Download verification failed", errorAction: "update",
  }} />);
  expect(screen.getByRole("alert").textContent).toContain("Download verification failed");
  screen.getByRole("button", { name: "Retry update" }).click();
  expect(retry).toHaveBeenCalledOnce();
});

it("renders subscription errors in Settings and uses platform-specific actions", () => {
  const base = { uiBuild: "dev", checking: false, updating: false, check: vi.fn(), updateNative: vi.fn(), reloadHosted: vi.fn() } satisfies UpdateController;
  const { rerender } = render(<UpdateSettings updates={{ ...base, nativeState: { ...ready("win32"), status: "error", message: "Timer check failed" } }} platformKind="desktop" hasNativeHost />);
  expect(screen.getByRole("alert").textContent).toContain("Timer check failed");
  expect(screen.getByRole("button", { name: "Retry update" })).toBeTruthy();
  rerender(<UpdateSettings updates={{ ...base, nativeState: ready("win32") }} platformKind="desktop" hasNativeHost />);
  expect(screen.getByRole("button", { name: "Update and restart" })).toBeTruthy();
  rerender(<UpdateSettings updates={{ ...base, nativeState: ready("darwin") }} platformKind="desktop" hasNativeHost />);
  expect(screen.getByRole("button", { name: "Open DMG" })).toBeTruthy();
  rerender(<UpdateSettings updates={{ ...base, nativeState: { ...ready("android"), status: "available", progress: { transferred: 0, total: 2048, percent: 0 } } }} platformKind="android" hasNativeHost />);
  expect(screen.getByRole("button", { name: "Download and install" })).toBeTruthy();
});
