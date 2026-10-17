import { useEffect, useRef } from "react";
import type { Id } from "@mdc/contracts";
import { DictationSession, messageAcknowledged, insertedAtSelection, type DictationBridge, type DictationAuthority, type EditorSnapshot, type DictationCancelReason } from "./dictation.js";
import type { CloudSnapshot } from "./cloud.js";
import type { ItemRecord } from "./model.js";
import { PlatformCommitEvents, platformCommitKey } from "./platform-commit-events.js";

type Options = {
  bridge?: DictationBridge;
  read(): EditorSnapshot | undefined;
  eligible(): boolean;
  owns?(before: EditorSnapshot): boolean;
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
    let platformCommit: PlatformCommitEvents | undefined;
    const cancel = (reason: DictationCancelReason = "RENDERER_CANCELLED") => {
      authority.abort(); platformCommit?.dispose(); platformCommit = undefined;
      session?.interfere(reason); unwatch?.(); unwatch = undefined;
      if (session) void bridge.report({ id: session.id, phase: "cancelled", reason: session.reason }).catch(() => {});
    };
    // Install before reading/preparing any session. This aborts IDB while send
    // is awaiting; native-only cancellation never waits for the next poll.
    const stopRevoked = bridge.subscribeRevoked(id => { if (session?.id === id) cancel("RENDERER_REVOKED"); });
    const interference = (event: Event) => {
      if (!session) return;
      if (platformCommit && ["keydown", "keyup", "beforeinput", "input"].includes(event.type)) { platformCommit.observe(event); return; }
      if (event.type === "keydown" && platformCommitKey(event) && !queued && !session.invalid && ["recording", "processing"].includes(session.phase)) {
        const owner = session, before = owner.before, editor = latest.current.read();
        const target = event.target;
        if (!(target instanceof HTMLTextAreaElement) || document.activeElement !== target || !editor?.focused || !latest.current.eligible()
          || editor.chatId !== before.chatId || editor.revision !== before.revision || editor.text !== before.text || editor.start !== before.start || editor.end !== before.end || editor.code !== before.code || !bridge.confirmProvisional) { cancel("RENDERER_KEY"); return; }
        // A renderer poll may still say recording. Only fresh native accepted processing input can validate the buffered chain.
        platformCommit = new PlatformCommitEvents(target, () => bridge.confirmProvisional!({ id: owner.id, contextId: before.chatId, revision: before.revision }),
          phase => {
            const current = latest.current, editor = current.read();
            const sameOwner = current.owns?.(before) ?? (editor?.chatId === before.chatId && editor.code === before.code && editor.focused);
            if (!live || session !== owner || owner.invalid || queued || !current.eligible() || document.activeElement !== target || !sameOwner) return false;
            // At document capture, DOM input precedes React onChange. Only this exact step may use stable ownership instead of a settled editor read.
            if (phase === "input-capture") return true;
            return editor !== undefined && editor.chatId === before.chatId && editor.code === before.code && editor.focused
              && (phase !== "proof" || insertedAtSelection(before, editor));
          },
          () => cancel("RENDERER_KEY"));
        platformCommit.observe(event); return;
      }
      if (["keyup", "beforeinput", "input"].includes(event.type)) return;
      cancel(event.type === "keydown" ? "RENDERER_KEY" : event.type === "pointerdown" ? "RENDERER_POINTER" : event.type === "paste" ? "RENDERER_PASTE" : event.type === "drop" ? "RENDERER_DROP" : "RENDERER_COMPOSITION");
    };
    const events = ["keydown", "keyup", "beforeinput", "input", "pointerdown", "paste", "drop", "compositionstart"];
    for (const event of events) document.addEventListener(event, interference, true);
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
          if (!editor || !latest.current.eligible()) { await bridge.report({ id: state.id, phase: "cancelled", reason: !editor ? "RENDERER_READ" : "RENDERER_ELIGIBILITY" }); return; }
          session = new DictationSession(state.id, editor);
          await bridge.report({ id: state.id, phase: "prepared", contextId: editor.chatId, revision: editor.revision });
        }
        if (!session || state.id !== session.id || session.invalid) return;
        if (state.phase === "cancelled") { cancel(); return; }
        if (!latest.current.eligible()) { cancel("RENDERER_ELIGIBILITY"); return; }
        const editor = latest.current.read();
        if (!editor || editor.chatId !== session.before.chatId) { cancel(!editor ? "RENDERER_READ" : "RENDERER_CHAT"); return; }
        if (queued) return;
        if (["recording", "processing", "complete"].includes(state.phase)) session.recording();
        if (["processing", "complete"].includes(state.phase) && session.phase === "recording") session.finishing(Date.now());
        if (platformCommit?.pending) return;
        if (!session.observe(editor, Date.now())) { cancel(session.reason); return; }
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
            void bridge.report({ id: owner.id, phase: "synced", ...result }).catch(() => cancel("RENDERER_FAILURE"));
          }, () => cancel("RENDERER_FAILURE"));
          if (acknowledged || owner.invalid || !live) stop(); else unwatch = stop;
        }
      } catch { cancel("RENDERER_FAILURE"); }
      finally { running = false; }
    };
    const timer = window.setInterval(() => void poll(), 150);
    void poll();
    return () => { live = false; stopRevoked(); window.clearInterval(timer); cancel("RENDERER_DISPOSED"); for (const event of events) document.removeEventListener(event, interference, true); };
  }, [bridge]);
}
