import type { Id } from "@mdc/contracts";
import type { ContextRecord, ItemRecord } from "./model.js";
import type { CloudSnapshot } from "./cloud.js";

export type DictationStatus = { id?: string; phase: string };
export type DictationClaim = { contextId: Id; itemId: Id };
export type DictationAuthority = { current(): boolean; signal: AbortSignal; validate(claim: DictationClaim): Promise<void> };
export type DictationBridge = {
  authorize(value: { id: string; contextId: Id; revision: number; itemId: Id }): Promise<void>;
  subscribeRevoked(listener: (id: string) => void): () => void;
  read(): Promise<DictationStatus>;
  report(value: { id: string; phase: string; contextId?: string; revision?: number; itemId?: string }): Promise<void>;
};
export type EditorSnapshot = { chatId: Id; revision: number; text: string; start: number; end: number; code: boolean; focused: boolean };

/** A single replacement at the captured caret/range, without changing surrounding draft. */
export function insertedAtSelection(before: EditorSnapshot, after: EditorSnapshot): boolean {
  const prefix = before.text.slice(0, before.start), suffix = before.text.slice(before.end);
  const insertedLength = after.text.length - prefix.length - suffix.length;
  return after.chatId === before.chatId && after.code === before.code && after.focused
    && insertedLength > 0 && after.text !== before.text
    && after.text.startsWith(prefix) && after.text.endsWith(suffix)
    && after.start === prefix.length + insertedLength && after.end === after.start;
}

export function messageAcknowledged(snapshot: CloudSnapshot<ItemRecord>, chatId: Id, itemId: Id): boolean {
  return !snapshot.fromCache && !snapshot.hasPendingWrites && snapshot.records.some(item =>
    item.id === itemId && item.contextId === chatId && item.syncState === "synced" && item.ready);
}

/** New offline chats acquire a server context before their item listener is legal. */
export function watchDictationItems(cloud: {
  subscribeContexts(emit: (value: CloudSnapshot<ContextRecord>) => void, fail: (error: Error) => void): () => void;
  subscribeItems(chat: Id, emit: (value: CloudSnapshot<ItemRecord>) => void, fail: (error: Error) => void): () => void;
}, chat: Id, emit: (value: CloudSnapshot<ItemRecord>) => void, fail: () => void): () => void {
  let started = false, disposed = false, stopContexts: (() => void) | undefined, stopItems: (() => void) | undefined;
  const closeContexts = () => { const stop = stopContexts; stopContexts = undefined; stop?.(); };
  stopContexts = cloud.subscribeContexts(snapshot => {
    if (disposed || started || snapshot.fromCache || snapshot.hasPendingWrites || !snapshot.records.some(context => context.id === chat && context.syncState === "synced")) return;
    started = true; closeContexts();
    stopItems = cloud.subscribeItems(chat, value => { if (!disposed) emit(value); }, fail);
  }, fail);
  if (started) closeContexts();
  return () => { disposed = true; closeContexts(); const stop = stopItems; stopItems = undefined; stop?.(); };
}

/** Volatile authority: never restored from storage after process death/reload. */
export class DictationSession {
  readonly before: EditorSnapshot;
  phase = "prepared";
  invalid = false;
  changed = false;
  deadline = Infinity;
  stableSince = 0;
  lastText: string;
  lastRevision: number;
  constructor(readonly id: string, before: EditorSnapshot) {
    if (!before.focused || before.start < 0 || before.end < before.start || before.end > before.text.length) throw new Error("Editor not ready");
    this.before = { ...before }; this.lastText = before.text; this.lastRevision = before.revision;
  }
  interfere() { this.invalid = true; }
  observe(next: EditorSnapshot, now: number): boolean {
    if (this.invalid || next.chatId !== this.before.chatId || next.code !== this.before.code || !next.focused || now >= this.deadline) return !(this.invalid = true);
    if (next.text !== this.lastText || next.revision !== this.lastRevision) {
      // No editor changes are authorized before our accepted Done. One insertion
      // only; streamed/revised/manual/ambiguous changes are left for the user.
      if (this.phase !== "processing" || this.changed || !insertedAtSelection(this.before, next)) return !(this.invalid = true);
      this.changed = true; this.lastText = next.text; this.lastRevision = next.revision; this.stableSince = now;
    } else if (!this.changed && (next.start !== this.before.start || next.end !== this.before.end)) return !(this.invalid = true);
    if (this.changed && !insertedAtSelection(this.before, next)) return !(this.invalid = true);
    return true;
  }
  recording() { if (this.phase === "prepared") this.phase = "recording"; }
  finishing(now: number) { if (this.phase !== "recording") { this.invalid = true; return; } this.phase = "processing"; this.deadline = now + 60_000; }
  ready(next: EditorSnapshot, now: number): boolean {
    return this.observe(next, now) && this.phase === "processing" && this.changed && now - this.stableSince >= 600;
  }
}
