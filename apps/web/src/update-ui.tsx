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
  errorAction?: "check" | "update" | "reload";
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
  current(): boolean;
  canInstall(): boolean;
  scope: unknown;
}): UpdateController {
  const [nativeState, setNativeState] = useState<UpdateState>();
  const [hostedBuild, setHostedBuild] = useState<string>();
  const [error, setError] = useState<string>();
  const [errorAction, setErrorAction] = useState<"check" | "update" | "reload">();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const monitor = useRef<HostedUpdateMonitor | undefined>(undefined);
  const nativeGeneration = useRef(0);
  const nativeRevision = useRef(0);
  const latestNativeState = useRef<UpdateState | undefined>(undefined);
  const freezeOwner = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    if (options.platformKind === "android") return;
    const next = new HostedUpdateMonitor(currentUiBuild, fetch, setHostedBuild, message => {
      setError(message); setErrorAction("check");
    });
    monitor.current = next;
    next.start();
    return () => { if (monitor.current === next) monitor.current = undefined; next.dispose(); };
  }, [options.platformKind]);

  useEffect(() => {
    if (freezeOwner.current) {
      freezeOwner.current = undefined;
      options.freeze(false);
    }
    const generation = ++nativeGeneration.current;
    nativeRevision.current += 1;
    latestNativeState.current = undefined;
    setNativeState(undefined); setUpdating(false); setChecking(false);
    setError(undefined); setErrorAction(undefined);
    if (!options.nativeUpdates) return () => { nativeGeneration.current += 1; };
    let active = true;
    const initialRevision = nativeRevision.current;
    const stop = options.nativeUpdates.subscribe(state => {
      if (!active || nativeGeneration.current !== generation) return;
      nativeRevision.current += 1;
      latestNativeState.current = state;
      setNativeState(state);
    });
    void options.nativeUpdates.getUpdateState()
      .then(state => {
        if (active && nativeGeneration.current === generation && nativeRevision.current === initialRevision) {
          nativeRevision.current += 1;
          latestNativeState.current = state;
          setNativeState(state);
        }
      })
      .catch(() => {
        if (active && nativeGeneration.current === generation && nativeRevision.current === initialRevision) {
          setError("Could not read the native update status"); setErrorAction("check");
        }
    });
    return () => { active = false; nativeGeneration.current += 1; stop(); };
  }, [options.nativeUpdates, options.scope]);

  const check = useCallback(async () => {
    const generation = nativeGeneration.current;
    const current = () => nativeGeneration.current === generation && options.current();
    setChecking(true); setError(undefined); setErrorAction(undefined);
    try {
      const operations: Promise<unknown>[] = [];
      if (options.nativeUpdates) {
        const revision = nativeRevision.current;
        operations.push(options.nativeUpdates.checkForUpdates().then(state => {
          if (!current()) return;
          if (nativeRevision.current === revision) {
            nativeRevision.current += 1;
            latestNativeState.current = state;
            setNativeState(state);
            if (state.status === "error") throw new Error(state.message ?? "Native update check failed");
          }
        }));
      }
      if (options.platformKind !== "android" && monitor.current) operations.push(monitor.current.check(true));
      await Promise.all(operations);
    } catch (cause) {
      if (current()) { setError(cause instanceof Error ? cause.message : "Could not check for updates"); setErrorAction("check"); }
    } finally { if (current()) setChecking(false); }
  }, [options]);

  const updateNative = useCallback(async () => {
    if (!options.nativeUpdates || updating) return;
    const generation = nativeGeneration.current;
    const initialRevision = nativeRevision.current;
    const current = () => nativeGeneration.current === generation && options.current();
    const owner = Symbol("native update");
    const freeze = (value: boolean) => {
      if (value) {
        if (!current()) return;
        freezeOwner.current = owner; options.freeze(true);
      } else if (freezeOwner.current === owner) {
        freezeOwner.current = undefined; options.freeze(false);
      }
    };
    setUpdating(true); setError(undefined); setErrorAction(undefined);
    try {
      await prepareAndInstallNativeUpdate(options.nativeUpdates, options.platformKind === "android" ? "android" : "desktop", {
        settle: options.settle,
        freeze,
        current,
        canInstall: () => {
          const status = latestNativeState.current?.status;
          return options.canInstall() && status !== "installing"
            && (status !== "error" || nativeRevision.current === initialRevision);
        },
      });
    } catch (cause) {
      if (current()) { setError(cause instanceof Error ? cause.message : "Could not install the native update"); setErrorAction("update"); }
    } finally { if (current()) setUpdating(false); }
  }, [options, updating]);

  const reloadHosted = useCallback(async () => {
    if (!hostedBuild || updating) return;
    const generation = nativeGeneration.current;
    const current = () => nativeGeneration.current === generation && options.current();
    if (!current() || !options.canInstall()) {
      setError("Finish the current operation, then retry the UI update."); setErrorAction("reload");
      return;
    }
    const owner = Symbol("hosted update");
    const freeze = (value: boolean) => {
      if (value) {
        if (!current()) return;
        freezeOwner.current = owner; options.freeze(true);
      } else if (freezeOwner.current === owner) {
        freezeOwner.current = undefined; options.freeze(false);
      }
    };
    setUpdating(true); setError(undefined); setErrorAction(undefined); freeze(true);
    try {
      await options.settle();
      if (!current() || !options.canInstall()) throw new Error("The workspace changed before reload.");
      freeze(false);
      options.reload();
    } catch {
      freeze(false);
      if (current()) {
        setError("Could not save local work before reloading. Your current UI is still usable."); setErrorAction("reload");
        setUpdating(false);
      }
    }
  }, [hostedBuild, options, updating]);

  return { uiBuild: currentUiBuild, ...(hostedBuild ? { hostedBuild } : {}), ...(nativeState ? { nativeState } : {}),
    ...(error ? { error } : {}), ...(errorAction ? { errorAction } : {}), checking, updating, check, updateNative, reloadHosted };
}

function nativeActionLabel(state: UpdateState): string {
  if (state.status === "error") return state.availableVersion ? "Retry update" : "Retry check";
  if (state.platform === "win32") return "Update and restart";
  if (state.platform === "darwin") return state.status === "ready" ? "Open DMG" : "Download DMG";
  return "Download and install";
}

export function HostedUpdateNotice({ updates }: { updates: UpdateController }) {
  const native = updates.nativeState;
  const retryCheck = native?.status === "error" && !native.availableVersion;
  const nativeNotice = native && ["available", "downloading", "ready", "installing", "error"].includes(native.status);
  const nativeFailure = native?.status === "error" ? native.message ?? "The native update failed."
    : updates.errorAction === "update" ? updates.error : undefined;
  const hostedFailure = updates.errorAction === "reload" ? updates.error : undefined;
  if (!updates.hostedBuild && !nativeNotice) return null;
  return <>
    {nativeNotice ? <div className={`update-notice${updates.hostedBuild ? " native" : ""}`} role={nativeFailure ? "alert" : "status"}>
      <div className="native-update-copy">
        {nativeFailure ? <span>{nativeFailure}</span> : native.status === "downloading" ? <>
          <span>Downloading native version {native.availableVersion} · {Math.round(native.progress?.percent ?? 0)}%</span>
          <div className="native-update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={native.progress?.percent ?? 0}><i style={{ width: `${native.progress?.percent ?? 0}%` }} /></div>
          {native.progress ? <small>{bytes(native.progress.transferred)} of {bytes(native.progress.total)}</small> : null}
        </> : native.status === "installing" ? <span>Installing native version {native.availableVersion ?? "update"}…</span>
          : <><span>Native version {native.availableVersion}{native.progress?.total ? ` · ${bytes(native.progress.total)}` : ""} is {native.status === "ready" ? "ready" : "available"}.</span>
            {native.message ? <small>{native.message}</small> : null}</>}
      </div>
      {nativeFailure || native.status === "available" || native.status === "ready" || native.status === "error" ? <button type="button" disabled={updates.updating || updates.checking} onClick={() => void (retryCheck ? updates.check() : updates.updateNative())}>{retryCheck ? "Retry check" : nativeFailure ? "Retry update" : nativeActionLabel(native)}</button> : null}
    </div> : null}
    {updates.hostedBuild ? <div className="update-notice" role={hostedFailure ? "alert" : "status"}>
      <span>{hostedFailure ?? "A newer UI build is available."}</span>
      <button type="button" disabled={updates.updating} onClick={() => void updates.reloadHosted()}>{hostedFailure ? "Retry reload" : "Reload to update"}</button>
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
  const updateError = state?.status === "error" ? state.message ?? "The native update failed." : updates.error;
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
    {updateError ? <p className="update-error" role="alert">{updateError}</p> : null}
    <div className="update-actions">
      <button type="button" disabled={updates.checking || updates.updating} onClick={() => void updates.check()}>{updates.checking ? "Checking…" : "Check for updates"}</button>
      {updates.hostedBuild ? <button type="button" className="primary" disabled={updates.updating} onClick={() => void updates.reloadHosted()}>Reload to update</button> : null}
      {nativeAvailable && state?.status !== "downloading" ? <button type="button" className="primary" disabled={updates.updating || updates.checking} onClick={() => void (state.status === "error" && !state.availableVersion ? updates.check() : updates.updateNative())}>{updates.updating ? "Updating…" : nativeActionLabel(state)}</button> : null}
    </div>
    {platformKind === "android" && !hasNativeHost ? <p className="update-detail">Install the current Android app to enable native updates.</p> : null}
  </section>;
}
