import { contextIdFromPath, IdSchema, type Id } from "@mdc/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextRecord } from "./model.js";

type Draft = { text: string; code: boolean; local: boolean; title: string; createdAt: number };
const empty = (): Draft => ({ text: "", code: false, local: true, title: "New context", createdAt: Date.now() });
export function useNavigation(namespace: string, initialId?: Id) {
  const key = `mdc-drafts:${namespace}`;
  const initial = useRef<{ id: Id; drafts: Record<string, Draft> } | undefined>(undefined);
  if (!initial.current) {
    let drafts: Record<string, Draft> = {};
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
      for (const [id, value] of Object.entries(raw)) {
        const d = value as Draft;
        if (IdSchema.safeParse(id).success && typeof d?.text === "string" && typeof d.code === "boolean" && typeof d.local === "boolean" && typeof d.title === "string" && typeof d.createdAt === "number") drafts[id] = d;
      }
    } catch { /* unavailable local storage */ }
    const id = initialId ?? contextIdFromPath(location.pathname) ?? crypto.randomUUID();
    drafts[id] ??= { ...empty(), local: !initialId && !contextIdFromPath(location.pathname) };
    initial.current = { id, drafts };
  }
  const [state, setState] = useState(initial.current);
  const latest = useRef(state); latest.current = state;
  const update = useCallback((fn: (value: typeof state) => typeof state) => {
    const next = fn(latest.current); latest.current = next; setState(next);
    try { localStorage.setItem(key, JSON.stringify(next.drafts)); } catch { /* quota must not block navigation */ }
  }, [key]);
  const select = useCallback((id?: Id, replace = false) => {
    const nextId = id ?? crypto.randomUUID();
    update(s => ({ id: nextId, drafts: { ...s.drafts, [nextId]: s.drafts[nextId] ?? { ...empty(), local: !id } } }));
    const local = latest.current.drafts[nextId]?.local;
    const path = local ? "/" : `/contexts/${nextId}`;
    if (location.pathname !== path) history[replace ? "replaceState" : "pushState"]({}, "", path);
  }, [update]);
  const patch = useCallback((value: Partial<Draft>) => update(s => ({ ...s, drafts: { ...s.drafts, [s.id]: { ...(s.drafts[s.id] ?? empty()), ...value } } })), [update]);
  const commit = useCallback((id: string, sentText?: string) => update(s => {
    const draft = s.drafts[id];
    if (!draft) return s;
    return { ...s, drafts: { ...s.drafts, [id]: { ...draft, local: false, text: sentText !== undefined && draft.text === sentText ? "" : draft.text } } };
  }), [update]);
  const remove = useCallback((ids: string[]) => update(s => {
    const drafts = { ...s.drafts }; for (const id of ids) delete drafts[id];
    return { ...s, drafts };
  }), [update]);
  useEffect(() => {
    const pop = () => select(contextIdFromPath(location.pathname), true);
    window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop);
  }, [select]);
  const draft = state.drafts[state.id] ?? { ...empty(), local: false };
  const localContexts: ContextRecord[] = Object.entries(state.drafts).filter(([id, d]) => d.local && (d.text || id === state.id)).map(([id, d]) => ({ id, title: d.title === "New context" && d.text ? "Draft · " + d.text.slice(0, 40) : d.title, createdAt: d.createdAt, updatedAt: d.createdAt, syncState: "pending" }));
  return { selectedId: state.id, selectedRef: latest, select, patch, remove, commit, text: draft.text, codeMode: draft.code,
    localContexts, draftContext: localContexts.find(c => c.id === state.id), clear: () => localStorage.removeItem(key) };
}
