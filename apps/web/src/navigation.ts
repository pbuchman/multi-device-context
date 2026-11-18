import { contextIdFromPath, type Id } from "@mdc/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextRecord } from "./model.js";
import { DraftStore, emptyDraft, type Draft } from "./drafts.js";
import { subscribeLocal } from "./local-db.js";

const saveError = "Your draft could not be saved locally. Keep this tab open and retry.";

export function useNavigation(namespace: string, initialId?: Id) {
  const persistence = useMemo(() => ({
    store: new DraftStore(namespace),
    failedOperations: [] as (() => Promise<unknown>)[],
    failedWrites: new Map<string, Draft>(),
    initialized: false,
  }), [namespace]);
  const { store, failedOperations, failedWrites } = persistence;
  const [issue, setIssueState] = useState<string>();
  const [saveFailed, setSaveFailed] = useState<DraftStore>();
  const mounted = useRef(false);
  const generation = useRef(0);
  const setIssue = useCallback((message?: string, owner = generation.current) => {
    if (mounted.current && owner === generation.current) setIssueState(message);
  }, []);
  const [state, setState] = useState(() => {
    const id = initialId ?? contextIdFromPath(location.pathname) ?? crypto.randomUUID();
    return { id, drafts: { [id]: { ...emptyDraft(), local: !initialId && !contextIdFromPath(location.pathname) } } as Record<string, Draft> };
  });
  const latest = useRef(state); latest.current = state;
  const chain = useRef<Promise<void>>(Promise.resolve());
  const busy = useRef(0);
  const revisionRef = useRef(0);
  const reloadSequence = useRef(0);
  const update = useCallback((fn: (s: typeof state) => typeof state) => {
    const before = latest.current; const next = fn(before);
    const a = before.drafts[before.id], b = next.drafts[next.id];
    if (before.id !== next.id || a?.text !== b?.text || a?.code !== b?.code || a?.title !== b?.title || a?.local !== b?.local) revisionRef.current++;
    latest.current = next; setState(next);
  }, []);
  const reload = useCallback(async () => {
    if (!mounted.current) return;
    const sequence = ++reloadSequence.current;
    const drafts = await store.list();
    if (!mounted.current || sequence !== reloadSequence.current || busy.current) return;
    const selected = latest.current.id;
    const removed = (await Promise.all([...new Set([selected, ...failedWrites.keys()])].map(async id => (
      await store.isRemoved(id) ? id : undefined
    )))).filter(id => id !== undefined);
    // A completed write may already have started a newer reload. Its snapshot
    // must not be replaced by this older read after the write queue is idle.
    if (!mounted.current || sequence !== reloadSequence.current || busy.current) return;
    for (const id of removed) failedWrites.delete(id);
    setSaveFailed(failedOperations.length || failedWrites.size ? store : undefined);
    const restored = { ...drafts, ...Object.fromEntries(failedWrites) };
    if (removed.includes(latest.current.id)) {
      const id = crypto.randomUUID(); update(() => ({ id, drafts: { ...restored, [id]: emptyDraft() } })); history.replaceState({}, "", "/"); return;
    }
    update(s => ({ ...s, drafts: { ...(s.drafts[s.id] && !restored[s.id] ? { [s.id]: s.drafts[s.id]! } : {}), ...restored } }));
  }, [failedOperations, failedWrites, store, update]);
  const schedule = useCallback((operation?: () => Promise<void>) => {
    const owner = generation.current;
    busy.current++;
    chain.current = chain.current.then(operation).finally(async () => {
      busy.current--;
      if (!mounted.current || owner !== generation.current) return;
      setSaveFailed(failedOperations.length || failedWrites.size ? store : undefined);
      if (!busy.current) await reload().catch(() => setIssue("Could not restore local drafts", owner));
    });
  }, [failedOperations, failedWrites, reload, setIssue, store]);
  const queue = useCallback((operation: () => Promise<unknown>) => schedule(async () => {
    try { await operation(); } catch { failedOperations.push(operation); }
  }), [failedOperations, schedule]);
  useEffect(() => {
    mounted.current = true;
    const owner = generation.current;
    // Each setup owns its reload, including StrictMode's replay. A migration
    // or write already accepted continues in the queue after cleanup.
    if (persistence.initialized) schedule();
    else {
      persistence.initialized = true;
      queue(() => store.migrate());
    }
    const unsubscribe = subscribeLocal(() => { if (!busy.current) void reload().catch(() => setIssue("Could not synchronize local drafts", owner)); });
    return () => { mounted.current = false; generation.current++; reloadSequence.current++; unsubscribe(); };
  }, [persistence, queue, reload, schedule, setIssue, store]);
  const persist = useCallback((id: string, draft?: Draft) => {
    const owner = generation.current;
    schedule(async () => {
      // Retry resolves the failed write after any newer queued edits have settled.
      const next = draft ?? failedWrites.get(id);
      if (!next) return;
      try {
        if (await store.save(id, next)) setIssue("Concurrent changes were preserved in a Recovered draft.", owner);
        failedWrites.delete(id);
      } catch {
        failedWrites.set(id, next);
      }
    });
  }, [failedWrites, schedule, setIssue, store]);
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
    if (failedOperations.length || failedWrites.size) throw new Error(saveError);
  }, [failedOperations, failedWrites]);
  const commit = useCallback((id: string, sentText?: string) => {
    const draft = latest.current.drafts[id]; if (!draft) return;
    const next = { ...draft, local: false, text: sentText !== undefined && draft.text === sentText ? "" : draft.text };
    update(s => ({ ...s, drafts: { ...s.drafts, [id]: next } })); persist(id, next);
  }, [update, persist]);
  const remove = useCallback((ids: string[]) => {
    update(s => ({ ...s, drafts: Object.fromEntries(Object.entries(s.drafts).filter(([id]) => !ids.includes(id))) }));
    queue(async () => {
      await store.remove(ids);
      for (const id of ids) failedWrites.delete(id);
    });
  }, [failedWrites, store, queue, update]);
  useEffect(() => { const pop = () => select(contextIdFromPath(location.pathname), true); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, [select]);
  const draft = state.drafts[state.id] ?? { ...emptyDraft(), local: false };
  const localContexts: ContextRecord[] = Object.entries(state.drafts).filter(([, d]) => d.local && (d.text || d.title !== "New context")).map(([id, d]) => ({ id, title: d.title === "New context" && d.text ? "Draft · " + d.text.slice(0, 40) : d.title, createdAt: d.createdAt, updatedAt: d.createdAt, syncState: "pending" }));
  return { selectedId: state.id, selectedRef: latest, revisionRef, select, patch, patchFor, flush, remove, commit, text: draft.text, codeMode: draft.code, issue: saveFailed === store ? saveError : issue,
    localContexts, draftContext: localContexts.find(c => c.id === state.id), retry: () => {
      setIssue(undefined);
      for (const operation of failedOperations.splice(0)) queue(operation);
      for (const id of failedWrites.keys()) persist(id);
    }, clear: async () => { await chain.current; await store.clear(); } };
}
