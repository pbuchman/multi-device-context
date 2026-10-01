import { openLocalDatabase, result, done, changed } from "./local-db.js";
import type { Draft } from "./drafts.js";

export type SignOutSummary = Readonly<{ token: string; drafts: number; webShares: number; nativeBatches: number; deletions: number }>;
export type SignOutResult = { status: "changed"; summary: SignOutSummary } | { status: "complete" };
export type SignOutStage = "preparation" | "auth" | "cleanup" | "handoff";
export class SignOutError extends Error {
  constructor(readonly stage: SignOutStage, readonly sessionMayBeInvalid: boolean, options?: ErrorOptions) {
    super(stage === "preparation" ? "Could not prepare sign-out. No sign-out cleanup was performed."
      : stage === "auth" ? "Sign-out is incomplete. Local drafts and queued web items have not been cleared. Native sign-out may already have removed credentials or incoming shares. Retry to finish."
        : stage === "cleanup" ? "The session may be signed out, but local cleanup is incomplete. Retry to finish clearing this account's local data."
          : "Local cleanup completed, but the final sign-out navigation failed. Retry to finish.", options);
    if (options?.cause instanceof Error && options.cause.message) this.message += ` ${options.cause.message}`;
    this.name = "SignOutError";
  }
}
export interface AccountSignOut {
  readonly locked: boolean;
  prepare(settleDrafts?: () => Promise<void>): Promise<SignOutSummary>;
  confirm(summary: SignOutSummary, settleDrafts?: () => Promise<void>): Promise<SignOutResult>;
  retry(): Promise<SignOutResult>;
}
export type SignOutPorts = {
  namespace: string;
  readNativeRequests?: () => Promise<readonly { id: string }[]>;
  checkAvailable?(): void;
  /** Synchronously disable intake and stop publication; restore only pre-auth state. */
  pause(): () => void;
  /** Wait for already started local/native work. Never flush uploads to the server. */
  settle(): Promise<void>;
  /** Invalidate auth first, invoke cleanup, then complete any external navigation. */
  signOut(cleanup: () => Promise<void>, nativeIds: readonly string[]): Promise<void>;
};
type LocalInventory = { drafts: string[]; webShares: string[]; deletions: string[] };
type Inventory = LocalInventory & { nativeBatches: string[] };
type LocalDraft = Draft & { id: string };
type LocalRecord = { key: string; kind: string };
const noop = async () => {};
function localInventory(drafts: LocalDraft[], records: LocalRecord[]): LocalInventory {
  return {
    drafts: drafts.filter(d => d.text.length > 0 || (d.local && d.title !== "New context"))
      .map(d => JSON.stringify([d.id, d.text, d.code, d.title])),
    webShares: records.filter(r => r.kind === "action").map(r => r.key),
    deletions: records.filter(r => r.kind === "deletion").map(r => r.key),
  };
}
async function readLocal(namespace: string): Promise<LocalInventory> {
  const db = await openLocalDatabase();
  try {
    const tx = db.transaction(["drafts", "records"], "readonly"), complete = done(tx);
    const [drafts, records] = await Promise.all([
      result(tx.objectStore("drafts").index("namespace").getAll(namespace)) as Promise<LocalDraft[]>,
      result(tx.objectStore("records").index("namespace").getAll(namespace)) as Promise<LocalRecord[]>,
    ]);
    await complete;
    return localInventory(drafts, records);
  } finally { db.close(); }
}
function grew(current: LocalInventory | Inventory, previous: LocalInventory | Inventory): boolean {
  return Object.entries(current).some(([kind, entries]) => {
    const old = new Set(previous[kind as keyof typeof previous]);
    return (entries as string[]).some(entry => !old.has(entry));
  });
}
class LossChanged extends Error {}
async function purgeLocal(namespace: string, expected: LocalInventory): Promise<void> {
  // Migration completes before preparation. Removing legacy state first prevents
  // reimport if navigation fails after the IndexedDB cleanup commits.
  localStorage.removeItem(`mdc-drafts:${namespace}`);
  const db = await openLocalDatabase();
  try {
    const tx = db.transaction(["drafts", "records"], "readwrite"), complete = done(tx);
    try {
      const [drafts, records] = await Promise.all([
        result(tx.objectStore("drafts").index("namespace").getAll(namespace)) as Promise<(LocalDraft & { key: string })[]>,
        result(tx.objectStore("records").index("namespace").getAll(namespace)) as Promise<LocalRecord[]>,
      ]);
      if (grew(localInventory(drafts, records), expected)) throw new LossChanged();
      for (const draft of drafts) tx.objectStore("drafts").delete(draft.key);
      for (const record of records) tx.objectStore("records").delete(record.key);
      await complete;
    } catch (error) {
      try { tx.abort(); } catch { /* IndexedDB may have already aborted. */ }
      await complete.catch(() => {});
      throw error;
    }
  } finally { db.close(); }
  changed();
}

export function createAccountSignOut(ports: SignOutPorts): AccountSignOut {
  const snapshots = new Map<string, Inventory>();
  let locked = false, authStarted = false, completed = false, purged = false;
  let restore: (() => void) | undefined;
  let confirmed: SignOutSummary | undefined, reconfirm: SignOutSummary | undefined;
  let settleDrafts = noop;
  let operation: Promise<SignOutResult> | undefined;
  const read = async (): Promise<Inventory> => {
    const [local, native] = await Promise.all([readLocal(ports.namespace), ports.readNativeRequests?.() ?? []]);
    return { ...local, nativeBatches: [...new Set(native.map(request => request.id))] };
  };
  const summarize = (inventory: Inventory): SignOutSummary => {
    const token = crypto.randomUUID();
    snapshots.clear(); snapshots.set(token, inventory);
    return Object.freeze({ token, drafts: inventory.drafts.length, webShares: inventory.webShares.length,
      nativeBatches: inventory.nativeBatches.length, deletions: inventory.deletions.length });
  };
  const unlockPreparation = () => {
    if (authStarted) return;
    const resume = restore; restore = undefined; locked = false; resume?.();
  };
  const run = async (summary: SignOutSummary, flush: () => Promise<void>): Promise<SignOutResult> => {
    if (completed) return { status: "complete" };
    const expected = snapshots.get(summary.token);
    if (!expected) throw new SignOutError("preparation", authStarted);
    let stage: SignOutStage = "preparation";
    try {
      if (!authStarted) ports.checkAvailable?.();
      if (purged) {
        stage = "handoff";
        await ports.signOut(noop, expected.nativeBatches);
        completed = true;
        return { status: "complete" };
      }
      if (!locked) { locked = true; restore = ports.pause(); }
      await Promise.all([flush(), ports.settle()]);
      const current = await read();
      if (grew(current, expected)) {
        reconfirm = summarize(current); unlockPreparation();
        return { status: "changed", summary: reconfirm };
      }
      confirmed = summary; settleDrafts = flush; reconfirm = undefined;
      authStarted = true; stage = "auth";
      await ports.signOut(async () => {
        stage = "cleanup";
        await purgeLocal(ports.namespace, current);
        purged = true;
        stage = "handoff";
      }, current.nativeBatches);
      completed = true;
      return { status: "complete" };
    } catch (cause) {
      if (cause instanceof LossChanged) {
        try {
          reconfirm = summarize(await read());
          return { status: "changed", summary: reconfirm };
        } catch (readError) { throw new SignOutError("cleanup", authStarted, { cause: readError }); }
      }
      unlockPreparation();
      throw new SignOutError(stage, authStarted, { cause });
    }
  };
  const confirm = (summary: SignOutSummary, flush = noop): Promise<SignOutResult> => {
    if (operation) return operation;
    const pending = run(summary, flush);
    operation = pending;
    void pending.finally(() => { if (operation === pending) operation = undefined; }).catch(() => {});
    return pending;
  };
  return {
    get locked() { return locked; },
    async prepare(flush = noop) {
      if (locked || authStarted || operation) throw new SignOutError("preparation", authStarted);
      try { ports.checkAvailable?.(); await flush(); return summarize(await read()); }
      catch (cause) { throw new SignOutError("preparation", false, { cause }); }
    },
    confirm,
    retry() {
      if (reconfirm) return Promise.resolve({ status: "changed", summary: reconfirm });
      if (!confirmed || !authStarted) return Promise.reject(new SignOutError("preparation", authStarted));
      return confirm(confirmed, settleDrafts);
    },
  };
}
