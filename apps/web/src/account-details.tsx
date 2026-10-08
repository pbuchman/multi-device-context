import { useEffect, useState, useSyncExternalStore } from "react";
import type { ProfileState, SessionProfile } from "./account-profile.js";
import type { Viewer } from "./model.js";
import { AccountAvatar } from "./account-avatar.js";
export const readyProfileState: ProfileState = { status: "ready", retryAt: 0 };
export const defaultProfileState = () => readyProfileState;
const emptySubscribe = () => () => {};
export function AccountDetails({ viewer, profile }: { viewer: Viewer; profile?: SessionProfile | undefined }) {
  const state = useSyncExternalStore(profile?.getState ? profile.subscribe : emptySubscribe, profile?.getState ?? defaultProfileState);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const remaining = state.retryAt - Date.now();
    if (remaining <= 0) { setNow(Date.now());return; }
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [state.retryAt]);
  const loading = state.status === "loading";
  return <>
    <div className="profile-row"><AccountAvatar name={viewer.name} avatarUrl={viewer.avatarUrl} large /><span><strong>{viewer.name}</strong><small>{viewer.email ?? (loading ? "Loading account…" : "Account details unavailable")}</small></span></div>
    {state.status === "unavailable" ? <p className="dialog-description" role="status">{state.message}{state.diagnostic ? <><br /><small>Diagnostic: {state.diagnostic.category}{state.diagnostic.status ? ` · HTTP ${state.diagnostic.status}` : ""} · Local reference {state.diagnostic.reference}</small></> : null}</p> : null}
    {profile?.refresh ? <button type="button" className="dialog-action" aria-busy={loading} disabled={loading || state.retryAt > now} onClick={() => void profile.refresh!()}>{loading ? "Loading account details…" : state.status === "unavailable" ? "Retry account details" : "Refresh account details"}</button> : null}
  </>;
}
