import { contextIdFromPath, type Id } from "@mdc/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextRecord } from "./model.js";
import { DraftStore, emptyDraft, type Draft } from "./drafts.js";
import { subscribeLocal } from "./local-db.js";

const saveError = "Your draft could not be saved locally. Keep this tab open and retry.";

export function useNavigation(namespace: string, initialId?: Id) {
  const store = useMemo(() => new DraftStore(namespace), [namespace]);
  const [issue, setIssue] = useState<string>();
  const [saveFailed, setSaveFailed] = useState(false);
  const [state, setState] = useState(() => {
    const id = initialId ?? contextIdFromPath(location.pathname) ?? crypto.randomUUID();
    return { id, drafts: { [id]: { ...emptyDraft(), local: !initialId && !contextIdFromPath(location.pathname) } } as Record<string, Draft> };
  });
  const latest = useRef(state); latest.current = state;
  const chain = useRef<Promise<void>>(Promise.resolve());
  const busy = useRef(0);
  const failedOperations = useRef<(() => Promise<unknown>)[]>([]);
  const failedWrites = useRef(new Map<string, Draft>());
  const initialized = useRef(false);
  const revisionRef = useRef(0);
  const reloadSequence = useRef(0);
  const update = useCallback((fn: (s: typeof state) => typeof state) => {
    const before = latest.current; const next = fn(before);
    const a = before.drafts[before.id], b = next.drafts[next.id];
    if (before.id !== next.id || a?.text !== b?.text || a?.code !== b?.code || a?.title !== b?.title || a?.local !== b?.local) revisionRef.current++;
    latest.current = next; setState(next);
  }, []);
  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const drafts = await store.list();
    const selected = latest.current.id;
    const removed = (await Promise.all([...new Set([selected, ...failedWrites.current.keys()])].map(async id => (
      await store.isRemoved(id) ? id : undefined
    )))).filter(id => id !== undefined);
    // A completed write may already have started a newer reload. Its snapshot
    // must not be replaced by this older read after the write queue is idle.
    if (sequence !== reloadSequence.current || busy.current) return;
    for (const id of removed) failedWrites.current.delete(id);
    setSaveFailed(failedOperations.current.length > 0 || failedWrites.current.size > 0);
    const restored = { ...drafts, ...Object.fromEntries(failedWrites.current) };
    if (removed.includes(latest.current.id)) {
      const id = crypto.randomUUID(); update(() => ({ id, drafts: { ...restored, [id]: emptyDraft() } })); history.replaceState({}, "", "/"); return;
    }
    update(s => ({ ...s, drafts: { ...(s.drafts[s.id] && !restored[s.id] ? { [s.id]: s.drafts[s.id]! } : {}), ...restored } }));
  }, [store, update]);
  const schedule = useCallback((operation: () => Promise<void>) => {
    busy.current++;
    chain.current = chain.current.then(operation).finally(async () => {
      setSaveFailed(failedOperations.current.length > 0 || failedWrites.current.size > 0);
      busy.current--; if (!busy.current) await reload().catch(() => setIssue("Could not restore local drafts"));
    });
  }, [reload]);
  const queue = useCallback((operation: () => Promise<unknown>) => schedule(async () => {
    try { await operation(); } catch { failedOperations.current.push(operation); }
  }), [schedule]);
  useEffect(() => {
    if (!initialized.current) { initialized.current = true; queue(async () => { await store.migrate(); }); }
    return subscribeLocal(() => { if (!busy.current) void reload().catch(() => setIssue("Could not synchronize local drafts")); });
  }, [store, queue, reload]);
  const persist = useCallback((id: string, draft?: Draft) => schedule(async () => {
    // Retry resolves the failed write after any newer queued edits have settled.
    const next = draft ?? failedWrites.current.get(id);
    if (!next) return;
    try {
      if (await store.save(id, next)) setIssue("Concurrent changes were preserved in a Recovered draft.");
      failedWrites.current.delete(id);
    } catch {
      failedWrites.current.set(id, next);
    }
  }), [store, schedule]);
  const select = useCallback((id?: Id, replace = false) => {
    const nextId = id ?? crypto.randomUUID();
    update(s => ({ id: nextId, drafts: { ...s.drafts, [nextId]: s.drafts[nextId] ?? { ...emptyDraft(), local: !id } } }));
    const path = latest.current.drafts[nextId]?.local ? "/" : `/contexts/${nextId}`;
    if (location.pathname !== path) history[replace ? "replaceState" : "pushState"]({}, "", path);
  }, [update]);
  const patchFor = useCallback((id: string, value: Partial<Draft>) => {
    const next = { ...(latest.current.drafts[id] ?? emptyDraft()), ...value };
    update(s => ({ ...s, drafts: { ...s.drafts, [id]: next } })); persist(id, next);
  }, [update, persist]);
  const patch = useCallback((value: Partial<Draft>) => patchFor(latest.current.id, value), [patchFor]);
  const flush = useCallback(async () => {
    await chain.current;
    if (failedOperations.current.length || failedWrites.current.size) throw new Error(saveError);
  }, []);
  const commit = useCallback((id: string, sentText?: string) => {
    const draft = latest.current.drafts[id]; if (!draft) return;
    const next = { ...draft, local: false, text: sentText !== undefined && draft.text === sentText ? "" : draft.text };
    update(s => ({ ...s, drafts: { ...s.drafts, [id]: next } })); persist(id, next);
  }, [update, persist]);
  const remove = useCallback((ids: string[]) => {
    update(s => ({ ...s, drafts: Object.fromEntries(Object.entries(s.drafts).filter(([id]) => !ids.includes(id))) }));
    queue(async () => {
      await store.remove(ids);
      for (const id of ids) failedWrites.current.delete(id);
    });
  }, [store, queue, update]);
  useEffect(() => { const pop = () => select(contextIdFromPath(location.pathname), true); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, [select]);
  const draft = state.drafts[state.id] ?? { ...emptyDraft(), local: false };
  const localContexts: ContextRecord[] = Object.entries(state.drafts).filter(([, d]) => d.local && (d.text || d.title !== "New context")).map(([id, d]) => ({ id, title: d.title === "New context" && d.text ? "Draft · " + d.text.slice(0, 40) : d.title, createdAt: d.createdAt, updatedAt: d.createdAt, syncState: "pending" }));
  return { selectedId: state.id, selectedRef: latest, revisionRef, select, patch, patchFor, flush, remove, commit, text: draft.text, codeMode: draft.code, issue: saveFailed ? saveError : issue,
    localContexts, draftContext: localContexts.find(c => c.id === state.id), retry: () => {
      setIssue(undefined);
      for (const operation of failedOperations.current.splice(0)) queue(operation);
      for (const id of failedWrites.current.keys()) persist(id);
    }, clear: async () => { await chain.current; await store.clear(); } };
}
