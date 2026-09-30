import { useEffect, useState } from "react";
import type { AgentKeyInfo } from "@mdc/contracts";
export type AgentKeyClient = {
  listKeys(): Promise<AgentKeyInfo[]>;
  createKey(name: string): Promise<AgentKeyInfo & { key: string }>;
  revokeKey(id: string): Promise<void>;
};
export function AgentKeys({ client }: { client: AgentKeyClient }) {
  const [keys, setKeys] = useState<AgentKeyInfo[]>([]);
  const [name, setName] = useState(""); const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>(); const [busy, setBusy] = useState(false);
  useEffect(() => { void client.listKeys().then(setKeys).catch(() => setError("Could not load agent keys")); }, [client]);
  return <section className="agent-keys"><h3>Agent access</h3><p>Keys allow reading, sharing and permanently deleting your contexts. Store them privately.</p>
    <form onSubmit={event => { event.preventDefault(); setBusy(true); setError(undefined); void client.createKey(name).then(result => { setSecret(result.key); setKeys(previous => [...previous, { id: result.id, name: result.name, createdAt: result.createdAt, lastUsedAt: result.lastUsedAt }]); setName(""); }).catch(() => setError("Could not create key")).finally(() => setBusy(false)); }}>
      <input aria-label="Agent key name" placeholder="e.g. Mac coding agent" maxLength={80} required value={name} onChange={event => setName(event.target.value)} />
      <button disabled={busy || !name.trim()}>Create key</button>
    </form>
    {secret ? <div><p>Copy now — this key is shown only once.</p><input aria-label="New agent key" readOnly value={secret} onFocus={e => e.target.select()} /><button onClick={() => setSecret(undefined)}>Done</button></div> : null}
    {keys.map(key => <div className="setting-row" key={key.id}><span>{key.name}<small>{key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}` : "Not used yet"}</small></span><button className="danger" onClick={() => {
      if (!window.confirm(`Revoke “${key.name}”? This agent will lose access.`)) return;
      void client.revokeKey(key.id).then(() => { setKeys(previous => previous.filter(k => k.id !== key.id)); setSecret(undefined); }).catch(() => setError("Could not revoke key"));
    }}>Revoke</button></div>)}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
