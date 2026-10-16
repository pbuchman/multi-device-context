import { useEffect, useRef } from "react";
import type { Id } from "@mdc/contracts";
import { DictationSession, messageAcknowledged, type DictationBridge, type DictationAuthority, type EditorSnapshot } from "./dictation.js";
import type { CloudSnapshot } from "./cloud.js";
import type { ItemRecord } from "./model.js";

type Options = {
  bridge?: DictationBridge;
  read(): EditorSnapshot | undefined;
  eligible(): boolean;
  send(id: Id, snapshot: EditorSnapshot, authority: DictationAuthority): Promise<{ contextId: Id; itemId: Id }>;
  watch(chat: Id, emit: (value: CloudSnapshot<ItemRecord>) => void, fail: () => void): () => void;
};

/** Native sessions are never reconstructed from an outbox marker on reload. */
export function useDictation(options: Options) {
  const latest = useRef(options); latest.current = options;
  const bridge = options.bridge;
  useEffect(() => {
    if (!bridge) return;
    let live = true, running = false, session: DictationSession | undefined;
    let queued = false, unwatch: (() => void) | undefined;
    let authority = new AbortController();
    const cancel = () => {
      authority.abort();
      session?.interfere(); unwatch?.(); unwatch = undefined;
      if (session) void bridge.report({ id: session.id, phase: "cancelled" }).catch(() => {});
    };
    // Install before reading/preparing any session. This aborts IDB while send
    // is awaiting; native-only cancellation never waits for the next poll.
    const stopRevoked = bridge.subscribeRevoked(id => { if (session?.id === id) cancel(); });
    const interference = (event: Event) => {
      // System dictation input has no key/paste/pointer action in this document.
      // Any human interaction during ownership is ambiguous and revokes sending
      // and late music resumption, including after the outbox commit.
      if (session) cancel();
    };
    for (const event of ["keydown", "pointerdown", "paste", "drop", "compositionstart"]) document.addEventListener(event, interference, true);
    const poll = async () => {
      if (!live || running) return;
      running = true;
      try {
        const state = await bridge.read();
        if (!live) return;
        if (state.id && state.phase === "begin" && session?.id !== state.id) {
          cancel();
          queued = false;
          authority = new AbortController();
          const editor = latest.current.read();
          if (!editor || !latest.current.eligible()) { await bridge.report({ id: state.id, phase: "cancelled" }); return; }
          session = new DictationSession(state.id, editor);
          await bridge.report({ id: state.id, phase: "prepared", contextId: editor.chatId, revision: editor.revision });
        }
        if (!session || state.id !== session.id || session.invalid) return;
        if (state.phase === "cancelled") { cancel(); return; }
        if (!latest.current.eligible()) { cancel(); return; }
        const editor = latest.current.read();
        if (!editor || editor.chatId !== session.before.chatId) { cancel(); return; }
        if (queued) return;
        if (["recording", "processing", "complete"].includes(state.phase)) session.recording();
        if (["processing", "complete"].includes(state.phase) && session.phase === "recording") session.finishing(Date.now());
        if (!session.observe(editor, Date.now())) { cancel(); return; }
        if (state.phase === "complete" && session.ready(editor, Date.now())) {
          // Claim before awaiting IndexedDB; an event/poll cannot enqueue twice.
          queued = true;
          const owner = session;
          const result = await latest.current.send(owner.id, editor, { signal: authority.signal,
            validate: claim => bridge.authorize({ id: owner.id, contextId: claim.contextId, revision: owner.before.revision, itemId: claim.itemId }),
            current: () => {
            const current = latest.current.read();
            return live && owner === session && !owner.invalid && latest.current.eligible() && current !== undefined && current.focused
              && current.chatId === editor.chatId && current.revision === editor.revision && current.code === editor.code
              && current.text === editor.text && current.start === editor.start && current.end === editor.end;
          } });
          if (!live || owner !== session || owner.invalid) return;
          await bridge.report({ id: owner.id, phase: "queued", ...result });
          if (!live || owner.invalid) return;
          let acknowledged = false;
          const stop = latest.current.watch(result.contextId, snapshot => {
            if (acknowledged || !live || owner.invalid || session !== owner || !messageAcknowledged(snapshot, result.contextId, result.itemId)) return;
            acknowledged = true;
            unwatch?.(); unwatch = undefined;
            void bridge.report({ id: owner.id, phase: "synced", ...result }).catch(cancel);
          }, cancel);
          if (acknowledged || owner.invalid || !live) stop(); else unwatch = stop;
        }
      } catch { cancel(); }
      finally { running = false; }
    };
    const timer = window.setInterval(() => void poll(), 150);
    void poll();
    return () => { live = false; stopRevoked(); window.clearInterval(timer); cancel(); for (const event of ["keydown", "pointerdown", "paste", "drop", "compositionstart"]) document.removeEventListener(event, interference, true); };
  }, [bridge]);
}
