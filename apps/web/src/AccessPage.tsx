import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@auth0/auth0-spa-js";
import type { AccessDevice } from "@mdc/contracts";
import { loadRuntimeConfig } from "./auth.js";
import { BrowserIdentity, safeAccessPath } from "./browser-identity.js";
import { AccessClient } from "./access-client.js";
import { AgentKeys, type AgentKeyClient } from "./AgentKeys.js";
import "./theme.css";
import "./access.css";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && (error.name === "NotAllowedError" || error.name === "AbortError")) return "Passkey confirmation was cancelled. Access was not changed.";
  return error instanceof Error ? error.message : "Access is unavailable. Try again.";
}
export function AccessPanel({ client, account, signOut }: { client: AccessClient; account: string; signOut?: () => Promise<void> }) {
  const [registered, setRegistered] = useState<boolean>();
  const [devices, setDevices] = useState<AccessDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const target = new URLSearchParams(window.location.search).get("device");
  const refresh = useCallback(async () => {
    const [status, current] = await Promise.all([client.status(), client.devices()]);
    setRegistered(status.passkeyRegistered); setDevices(current);
  }, [client]);
  useEffect(() => {
    let current = true;
    void Promise.all([client.status(), client.devices()]).then(([status, currentDevices]) => { if (current) { setRegistered(status.passkeyRegistered); setDevices(currentDevices); } }).catch(value => { if (current) setError(errorMessage(value)); });
    return () => { current = false; };
  }, [client]);
  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await operation(); } catch (value) { setError(errorMessage(value)); }
    finally { setBusy(false); }
  }, []);
  const keyClient = useMemo<AgentKeyClient>(() => ({
    listKeys: () => client.listKeys(),
    createKey: async name => { setBusy(true); try { return await client.createKey(name); } finally { setBusy(false); } },
    revokeKey: async id => { setBusy(true); try { await client.revokeKey(id); } finally { setBusy(false); } },
  }), [client]);
  return <main className="access-page">
    <header className="access-heading"><div><p>Multi Device Context</p><h1>Device access</h1><p>{account}</p></div>{signOut ? <button type="button" disabled={busy} onClick={() => void run(signOut)}>Sign out</button> : null}</header>
    <p>New installations can create and read their own contexts. Replies from your other devices remain visible inside those contexts.</p>
    {error ? <p className="access-error" role="alert">{error}</p> : null}
    {notice ? <p className="access-notice" role="status">{notice}</p> : null}
    {registered === undefined ? <p>Loading access… <button type="button" disabled={busy} onClick={() => void run(refresh)}>Retry</button></p> : <fieldset disabled={busy} className="access-controls">
      {!registered ? <section className="access-card"><h2>Create your passkey</h2><p>This passkey confirms changes to device access and agent keys. In Chrome, choose Google Password Manager to make it available on your other devices.</p><button type="button" onClick={() => void run(async () => { await client.register(); await refresh(); setNotice("Passkey registered. You can now choose access for each device."); })}>Create passkey</button></section> : <>
        <section className="access-card"><div className="access-section-heading"><h2>Your devices</h2><button type="button" onClick={() => void run(refresh)}>Refresh</button></div><p>Every change requires your passkey. After changing access, return to the app to refresh it.</p>
          {devices.length === 0 ? <p>No installations yet. Sign in to the app on your phone first.</p> : <ul className="access-devices">{devices.map(device => <li key={device.id} className={device.id === target ? "access-device-target" : ""}>
            <div><h3>{device.name}</h3><p>{device.platform} · {device.id.slice(0, 8)}{device.id === target ? " · Selected device" : ""}</p><strong>{device.mode === "all" ? "All contexts" : "Own contexts"}</strong></div>
            <button type="button" aria-label={`${device.mode === "all" ? "Limit to own contexts on" : "Allow all contexts on"} ${device.name}`} onClick={() => {
              if (device.mode === "all" && !window.confirm(`Limit “${device.name}” to its own contexts?\n\nWhen this device receives the change, unsent drafts, queued messages and files, and unfinished operations for contexts created on other devices will be removed from “${device.name}”. Already synced data remains available on your other devices.\n\nContinue to passkey confirmation?`)) return;
              void run(async () => {
                await client.perform({ action: "set-device-access", targetId: device.id, expectedVersion: device.version, mode: device.mode === "all" ? "own" : "all" });
                await refresh(); setNotice(`Access updated for ${device.name}. Return to the app to refresh it.`);
              });
            }}>{device.mode === "all" ? "Use own contexts" : "Allow all contexts"}</button>
          </li>)}</ul>}
        </section>
        <section className="access-card"><p>Creating or revoking an agent key also requires your passkey.</p><AgentKeys client={keyClient} /></section>
      </>}
    </fieldset>}
    <p className="access-footer"><a href="/">Open workspace</a></p>
  </main>;
}

/** Separate from App's workspace/session effect: browser administration must not enroll itself. */
export function AccessPage() {
  const [identity, setIdentity] = useState<BrowserIdentity>();
  const [signedIn, setSignedIn] = useState(false);
  const [account, setAccount] = useState("Your account");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const startup = useRef<{ attempt: number; operation: Promise<{ manager: BrowserIdentity; authenticated: boolean; profile: User | undefined }> } | undefined>(undefined);
  useEffect(() => {
    let current = true;
    if (!startup.current || startup.current.attempt !== attempt) startup.current = { attempt, operation: (async () => {
      const config = await loadRuntimeConfig(fetch, { mobile: false });
      if (window.location.origin !== config.appOrigin) throw new Error("Open device access on the application website in your browser.");
      const manager = new BrowserIdentity(config);
      const authenticated = await manager.restore();
      const profile = authenticated ? await manager.profile() : undefined;
      return { manager, authenticated, profile };
    })() };
    void startup.current.operation.then(({ manager, authenticated, profile }) => {
      if (!safeAccessPath(window.location.pathname + window.location.search)) { if (current) window.location.replace("/"); return; }
      if (current) { setIdentity(manager); setSignedIn(authenticated); setAccount(profile?.email ?? profile?.name ?? "Your account"); }
    }).catch(value => { if (current) setError(errorMessage(value)); });
    return () => { current = false; };
  }, [attempt]);
  const client = useMemo(() => identity ? new AccessClient(() => identity.accessToken()) : undefined, [identity]);
  if (signedIn && client && identity) return <AccessPanel client={client} account={account} signOut={() => identity.signOut()} />;
  return <main className="access-page"><header className="access-heading"><div><p>Multi Device Context</p><h1>Device access</h1></div></header><p>Sign in to your account. Changing access also requires your passkey.</p>
    {error ? <p className="access-error" role="alert">{error}</p> : null}
    <button type="button" disabled={!identity || busy} onClick={() => {
      if (!identity) return; setBusy(true); setError(undefined);
      void identity.login().then(authenticated => { if (authenticated) { setSignedIn(true); void identity.profile().then(profile => setAccount(profile?.email ?? profile?.name ?? "Your account")); } }).catch(value => setError(errorMessage(value))).finally(() => setBusy(false));
    }}>{busy ? "Signing in…" : "Sign in with Google"}</button>
    {!identity ? <button type="button" onClick={() => { setError(undefined); setAttempt(value => value + 1); }}>Retry</button> : null}
  </main>;
}
