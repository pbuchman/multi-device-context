import { assertLocalAccess, transactionAccess, allowedByLocalPolicy } from "./local-access.js";
import { IdSchema } from "@mdc/contracts";
import { openLocalDatabase, result, done, changed } from "./local-db.js";
export type Draft = { text: string; code: boolean; local: boolean; title: string; createdAt: number; revision?: number };
type Row = Draft & { key: string; namespace: string; id: string; revision: number; writer: string; legacyId?: string };
export const emptyDraft = (): Draft => ({ text: "", code: false, local: true, title: "New context", createdAt: Date.now(), revision: 0 });
function valid(value: unknown): value is Draft {
  const d = value as Draft;
  return !!d && typeof d.text === "string" && typeof d.code === "boolean" && typeof d.local === "boolean" && typeof d.title === "string" && Number.isFinite(d.createdAt);
}
export class DraftStore {
  private writer = crypto.randomUUID();
  constructor(readonly namespace: string) {}
  private key(id: string) { return `draft:${this.namespace}:${id}`; }
  async list(): Promise<Record<string, Draft>> {
    const db = await openLocalDatabase();
    try {
      const tx = db.transaction(["drafts", "records"], "readonly"); const complete = done(tx);
      const policy = await transactionAccess(tx.objectStore("records"), this.namespace);
      const rows = await result(tx.objectStore("drafts").index("namespace").getAll(this.namespace)) as Row[];
      await complete; return Object.fromEntries(rows.filter(valid).filter(d => allowedByLocalPolicy(policy, d.id)).map(d => [d.id, d]));
    } finally { db.close(); }
  }
  async save(id: string, draft: Draft): Promise<boolean> {
    const db = await openLocalDatabase(); let conflict = false;
    try {
      const tx = db.transaction(["drafts", "records"], "readwrite"); const complete = done(tx);
      const store = tx.objectStore("drafts");
      try {
        await assertLocalAccess(tx.objectStore("records"), this.namespace, id, draft.local);
        const removed = await result(tx.objectStore("records").get(`deleted:${this.namespace}:${id}`));
        if (!removed) {
          const previous = await result(store.get(this.key(id))) as Row | undefined;
          if (previous && previous.writer !== this.writer && previous.revision !== (draft.revision ?? 0) && previous.text !== draft.text && previous.text) {
            const recoveredId = crypto.randomUUID();
            await assertLocalAccess(tx.objectStore("records"), this.namespace, recoveredId, true);
            store.put({ ...previous, id: recoveredId, key: this.key(recoveredId), local: true, title: "Recovered draft", revision: 1, writer: this.writer });
            conflict = true;
          }
          store.put({ ...draft, id, key: this.key(id), namespace: this.namespace, revision: (previous?.revision ?? 0) + 1, writer: this.writer } satisfies Row);
        }
        await complete;
      } catch (error) {
        try { tx.abort(); } catch { /* Already aborted by IndexedDB. */ }
        await complete.catch(() => {}); throw error;
      }
    } finally { db.close(); }
    changed(); return conflict;
  }
  async isRemoved(id: string): Promise<boolean> {
    const db = await openLocalDatabase();
    try { return !!await result(db.transaction("records").objectStore("records").get(`deleted:${this.namespace}:${id}`)); }
    finally { db.close(); }
  }
  async remove(ids: string[]) {
    const db = await openLocalDatabase();
    try {
      const tx = db.transaction(["drafts", "records"], "readwrite"); const complete = done(tx);
      for (const id of ids) {
        tx.objectStore("drafts").delete(this.key(id));
        tx.objectStore("records").put({ key: `deleted:${this.namespace}:${id}`, kind: "deleted", namespace: this.namespace, contextId: id });
      }
      await complete;
    } finally { db.close(); }
    changed();
  }
  async migrate() {
    const key = `mdc-drafts:${this.namespace}`;
    const raw = localStorage.getItem(key); if (!raw) return;
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Unable to read older drafts");
    const db = await openLocalDatabase();
    try {
      const tx = db.transaction(["drafts", "records"], "readwrite"); const complete = done(tx);
      try {
        const policy = await transactionAccess(tx.objectStore("records"), this.namespace);
        const imported = await result(tx.objectStore("drafts").index("namespace").getAll(this.namespace)) as Row[];
        for (const [id, value] of Object.entries(data)) {
          if (!IdSchema.safeParse(id).success || !valid(value)) continue;
          if (await result(tx.objectStore("records").get(`deleted:${this.namespace}:${id}`))) continue;
          const previous = await result(tx.objectStore("drafts").get(this.key(id))) as Row | undefined;
          // Repeated migrations preserve a differing legacy draft, never overwrite a newer one.
          const target = previous && previous.text !== value.text ? crypto.randomUUID() : id;
          if (target !== id && imported.some(row => row.legacyId === id && row.text === value.text)) continue;
          // A generated recovery is new local work only when its source is
          // accessible. Unknown pre-enrollment histories stay quarantined.
          if (target !== id && allowedByLocalPolicy(policy, id)) await assertLocalAccess(tx.objectStore("records"), this.namespace, target, true);
          if (!previous || target !== id) tx.objectStore("drafts").put({ ...value, legacyId: id, local: target !== id || value.local, id: target, key: this.key(target), namespace: this.namespace, revision: 1, writer: this.writer });
        }
        await complete;
        if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
      } catch (error) {
        try { tx.abort(); } catch { /* Already completed or aborted by IndexedDB. */ }
        await complete.catch(() => {}); throw error;
      }
    } finally { db.close(); }
  }
  async clear() {
    const db = await openLocalDatabase();
    try {
      const tx = db.transaction("drafts", "readwrite"); const complete = done(tx);
      const rows = await result(tx.objectStore("drafts").index("namespace").getAll(this.namespace)) as Row[];
      for (const row of rows) tx.objectStore("drafts").delete(row.key);
      await complete; localStorage.removeItem(`mdc-drafts:${this.namespace}`);
    } finally { db.close(); }
    changed();
  }
}
