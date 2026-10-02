import { changed, done, openLocalDatabase, result } from "./local-db.js";

export type LocalPolicy = { id: string; mode: "own" | "all"; version: number };
export type AccessRow = { key: string; kind: "access"; namespace: string; deviceId: string; mode: "own" | "all"; version: number; own: string[] };
type Provenance = { key: string; kind: "local-context"; namespace: string; deviceId: string; contextId: string };
const policyKey = (namespace: string) => `access:${namespace}`;
const localKey = (namespace: string, id: string) => `local-context:${namespace}:${id}`;

/** Runs in the caller's mutation transaction, so a remote downgrade fences late writes in other tabs. */
export async function assertLocalAccess(store: IDBObjectStore, namespace: string, contextId: string, createsLocal = false): Promise<void> {
 const policy = await result(store.get(policyKey(namespace))) as AccessRow | undefined;
 if (!policy) return; // Isolated tests and existing data are never interpreted as an authorization grant.
 const provenance = await result(store.get(localKey(namespace, contextId))) as Provenance | undefined;
 if (policy.mode === "own" && !policy.own.includes(contextId) && provenance?.deviceId !== policy.deviceId && !createsLocal)
   throw new Error("Device access changed. This context is no longer available here.");
 if (createsLocal && !provenance) {
   store.put({ key: localKey(namespace, contextId), kind: "local-context", namespace, contextId, deviceId: policy.deviceId } satisfies Provenance);
   if (!policy.own.includes(contextId)) store.put({ ...policy, own: [...policy.own, contextId] });
 }
}

/** Access loss is not deletion. Keep true tombstones and native intake acknowledgements intact. */
export async function applyLocalAccess(namespace: string, policy: LocalPolicy, ownContextIds: readonly string[]): Promise<void> {
 const db = await openLocalDatabase();
 try {
  const tx = db.transaction(["records", "drafts"], "readwrite"), complete = done(tx);
  const records = tx.objectStore("records"), drafts = tx.objectStore("drafts");
  const previous = await result(records.get(policyKey(namespace))) as AccessRow | undefined;
  if (previous?.deviceId === policy.id && previous.version > policy.version) { await complete; return; }
  const rows = await result(records.index("namespace").getAll(namespace)) as ({ key: string; kind: string; contextId?: string; deviceId?: string })[];
  const own = new Set(ownContextIds);
  for (const row of rows) if (row.kind === "local-context" && row.deviceId === policy.id && row.contextId) own.add(row.contextId);
  const pruning = previous?.deviceId === policy.id && previous.mode === "all" && policy.mode === "own";
  if (pruning) {
   for (const row of rows) if (row.contextId && !own.has(row.contextId) && ["action", "deletion", "local-context"].includes(row.kind)) records.delete(row.key);
   const values = await result(drafts.index("namespace").getAll(namespace)) as { key: string; id: string }[];
   for (const row of values) if (!own.has(row.id)) drafts.delete(row.key);
  }
  records.put({ key: policyKey(namespace), kind: "access", namespace, deviceId: policy.id, mode: policy.mode, version: policy.version, own: [...own] } satisfies AccessRow);
  await complete;
 } finally { db.close(); }
 changed();
}

export function allowedByLocalPolicy(policy: AccessRow | undefined, contextId: string): boolean {
 return !policy || policy.mode === "all" || policy.own.includes(contextId);
}
export async function readLocalAccess(namespace: string): Promise<AccessRow | undefined> {
 const db = await openLocalDatabase();
 try { return await result(db.transaction("records").objectStore("records").get(policyKey(namespace))) as AccessRow | undefined; }
 finally { db.close(); }
}
export async function transactionAccess(store: IDBObjectStore, namespace: string): Promise<AccessRow | undefined> {
 return await result(store.get(policyKey(namespace))) as AccessRow | undefined;
}
