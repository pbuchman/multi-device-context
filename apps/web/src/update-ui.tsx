import type { UpdateState } from "@mdc/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { HostedUpdateMonitor, prepareAndInstallNativeUpdate, type NativeUpdateClient } from "./updates.js";

const currentUiBuild = typeof __MDC_UI_BUILD__ === "string" ? __MDC_UI_BUILD__ : "dev";

function shortBuild(build: string): string {
  return build === "dev" ? "development" : build.slice(0, 12);
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export type UpdateController = {
  uiBuild: string;
  hostedBuild?: string;
  nativeState?: UpdateState;
  error?: string;
  checking: boolean;
  updating: boolean;
  check(): Promise<void>;
  updateNative(): Promise<void>;
  reloadHosted(): Promise<void>;
};

export function useUpdateController(options: {
  platformKind: "browser" | "desktop" | "android";
  nativeUpdates?: NativeUpdateClient;
  settle(): Promise<void>;
  freeze(value: boolean): void;
  reload(): void;
}): UpdateController {
  const [nativeState, setNativeState] = useState<UpdateState>();
  const [hostedBuild, setHostedBuild] = useState<string>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const monitor = useRef<HostedUpdateMonitor | undefined>(undefined);

  useEffect(() => {
    if (options.platformKind === "android") return;
    const next = new HostedUpdateMonitor(currentUiBuild, fetch, setHostedBuild, setError);
    monitor.current = next;
    next.start();
    return () => { if (monitor.current === next) monitor.current = undefined; next.dispose(); };
  }, [options.platformKind]);

  useEffect(() => {
    if (!options.nativeUpdates) { setNativeState(undefined); return; }
    let active = true;
    const stop = options.nativeUpdates.subscribe(state => setNativeState(state));
    void options.nativeUpdates.getUpdateState()
      .then(state => { if (active) setNativeState(state); })
      .catch(() => { if (active) setError("Could not read the native update status"); });
    return () => { active = false; stop(); };
  }, [options.nativeUpdates]);

  const check = useCallback(async () => {
    setChecking(true); setError(undefined);
    try {
      const operations: Promise<unknown>[] = [];
      if (options.nativeUpdates) operations.push(options.nativeUpdates.checkForUpdates().then(state => {
        setNativeState(state);
        if (state.status === "error") throw new Error(state.message ?? "Native update check failed");
      }));
      if (options.platformKind !== "android" && monitor.current) operations.push(monitor.current.check(true));
      await Promise.all(operations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check for updates");
    } finally { setChecking(false); }
  }, [options.nativeUpdates, options.platformKind]);

  const updateNative = useCallback(async () => {
    if (!options.nativeUpdates || updating) return;
    setUpdating(true); setError(undefined);
    try {
      const ready = await prepareAndInstallNativeUpdate(options.nativeUpdates, options.platformKind === "android" ? "android" : "desktop", {
        settle: options.settle,
        freeze: options.freeze,
      });
      setNativeState(ready);
    } catch (cause) {
      options.freeze(false);
      setError(cause instanceof Error ? cause.message : "Could not install the native update");
    } finally { setUpdating(false); }
  }, [options, updating]);

  const reloadHosted = useCallback(async () => {
    if (!hostedBuild || updating) return;
    setUpdating(true); setError(undefined); options.freeze(true);
    try {
      await options.settle();
      options.freeze(false);
      options.reload();
    } catch {
      options.freeze(false);
      setError("Could not save local work before reloading. Your current UI is still usable.");
      setUpdating(false);
    }
  }, [hostedBuild, options, updating]);

  return { uiBuild: currentUiBuild, ...(hostedBuild ? { hostedBuild } : {}), ...(nativeState ? { nativeState } : {}),
    ...(error ? { error } : {}), checking, updating, check, updateNative, reloadHosted };
}

export function HostedUpdateNotice({ updates }: { updates: UpdateController }) {
  const native = updates.nativeState;
  const nativeNotice = native && (native.status === "available" || native.status === "ready") && native.availableVersion;
  if (!updates.hostedBuild && !nativeNotice) return null;
  return <>
    {nativeNotice ? <div className={`update-notice${updates.hostedBuild ? " native" : ""}`} role="status">
      <span>Native version {native.availableVersion}{native.progress?.total ? ` · ${bytes(native.progress.total)}` : ""} is {native.status === "ready" ? "ready" : "available"}.</span>
      <button type="button" disabled={updates.updating} onClick={() => void updates.updateNative()}>{native.status === "ready" ? "Install" : "Download and install"}</button>
    </div> : null}
    {updates.hostedBuild ? <div className="update-notice" role="status">
      <span>A newer UI build is available.</span>
      <button type="button" disabled={updates.updating} onClick={() => void updates.reloadHosted()}>Reload to update</button>
    </div> : null}
  </>;
}

export function UpdateSettings({ updates, platformKind, hasNativeHost }: {
  updates: UpdateController;
  platformKind: "browser" | "desktop" | "android";
  hasNativeHost: boolean;
}) {
  const state = updates.nativeState;
  const progress = state?.progress;
  const nativeAvailable = state?.status === "available" || state?.status === "ready" || state?.status === "error";
  return <section className="update-settings" aria-label="Updates">
    <div className="setting-row"><span>UI build<small>{shortBuild(updates.uiBuild)}{updates.hostedBuild ? ` · ${shortBuild(updates.hostedBuild)} available` : ""}</small></span></div>
    {hasNativeHost ? <div className="setting-row"><span>Native app<small>{state
      ? `Version ${state.currentVersion}${state.availableVersion ? ` · ${state.availableVersion} available` : ""}`
      : "Update details require the current native app."}</small></span></div> : null}
    {state?.status === "downloading" && progress ? <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
      <span>Downloading {Math.round(progress.percent)}%</span><small>{bytes(progress.transferred)} of {bytes(progress.total)}</small>
    </div> : null}
    {state?.status === "available" && progress ? <p className="update-detail">Native version {state.availableVersion} is available · {bytes(progress.total)}</p> : null}
    {state?.status === "up-to-date" ? <p className="update-detail">The native app is up to date.</p> : null}
    {updates.error ? <p className="update-error" role="alert">{updates.error}</p> : null}
    <div className="update-actions">
      <button type="button" disabled={updates.checking || updates.updating} onClick={() => void updates.check()}>{updates.checking ? "Checking…" : "Check for updates"}</button>
      {updates.hostedBuild ? <button type="button" className="primary" disabled={updates.updating} onClick={() => void updates.reloadHosted()}>Reload to update</button> : null}
      {nativeAvailable && state?.status !== "downloading" ? <button type="button" className="primary" disabled={updates.updating} onClick={() => void updates.updateNative()}>{state.status === "ready" ? "Install update" : updates.updating ? "Updating…" : "Download and install"}</button> : null}
    </div>
    {platformKind === "android" && !hasNativeHost ? <p className="update-detail">Install the current Android app to enable native updates.</p> : null}
  </section>;
}
