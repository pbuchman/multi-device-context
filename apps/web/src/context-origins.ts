import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextOrigin, Id } from "@mdc/contracts";
import type { ContextRecord } from "./model.js";

// The account assigns these indices. Never hash IDs or reassign a visible subset.
export const CONTEXT_ORIGIN_PALETTE = [
  ["#e8f0f8", "#d5e4f2", "#293847", "#344b60"],
  ["#efebf7", "#e2daf0", "#383247", "#4a405e"],
  ["#f7eee4", "#efdfcd", "#43382d", "#594a39"],
  ["#e7f2ec", "#d2e8dc", "#2a3d34", "#365044"],
  ["#f6e9ee", "#edd7e0", "#44303a", "#583e4b"],
  ["#e6f2f2", "#cfe6e6", "#293d3f", "#355154"],
  ["#f3f1e3", "#e8e2c9", "#3d3b2b", "#514e37"],
  ["#eceef1", "#dde1e8", "#333841", "#454c58"],
] as const;
export const EMPTY_ORIGINS: ReadonlyMap<string, ContextOrigin> = new Map();
export function contextOrigin(context: ContextRecord, origins: ReadonlyMap<string, ContextOrigin>) {
  return context.originDeviceId ? origins.get(context.originDeviceId) : undefined;
}
export function contextSourceLabel(context: ContextRecord, origins: ReadonlyMap<string, ContextOrigin>) {
  return `Created on: ${contextOrigin(context, origins)?.name ?? "Unknown device"}`;
}

/** Session-only cache, scoped to the exact workspace and its current authorization. */
export function useContextOrigins({ owner, contexts, confirmedIds, enabled, active, deviceName, accessMode, accessActive, load }: {
  owner: object; contexts: ContextRecord[]; confirmedIds?: ReadonlySet<Id>; enabled: boolean; active: boolean; deviceName: string;
  accessMode?: string | undefined; accessActive?: (() => boolean) | undefined;
  load?: ((contextIds: Id[]) => Promise<ContextOrigin[]>) | undefined;
}) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  // Titles, pin ordering and search do not change the request identity.
  const key = JSON.stringify(contexts.filter(context => confirmedIds ? confirmedIds.has(context.id) : context.syncState === "synced" || context.syncState === "cached")
    .map(context => [context.id, context.originDeviceId ?? ""]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
  const ids = useMemo(() => (JSON.parse(key) as [Id, string][]).map(([id]) => id), [key]);
  const [cache, setCache] = useState<{ owner: object; mode: string | undefined; origins: ReadonlyMap<string, ContextOrigin> }>();
  const generation = useRef(0);
  const allowed = enabled && (accessActive?.() ?? true);
  useEffect(() => {
    const current = ++generation.current;
    if (!allowed || !load) { setCache(undefined); return; }
    setCache(previous => previous?.owner === owner && previous.mode === accessMode ? previous : undefined);
    if (!active) return;
    let cancelled = false;
    const run = async () => {
      const origins = new Map<string, ContextOrigin>();
      for (let index = 0; index < ids.length; index += 100) {
        const records = await load(ids.slice(index, index + 100));
        if (cancelled || generation.current !== current || !(accessActive?.() ?? true)) return;
        for (const record of records) origins.set(record.id, record);
      }
      if (!cancelled && generation.current === current && (accessActive?.() ?? true)) setCache({ owner, mode: accessMode, origins });
    };
    // Metadata failure leaves the chat list usable and retains the last successful session result.
    void run().catch(() => {});
    return () => { cancelled = true; };
  }, [owner, allowed, active, accessMode, accessActive, deviceName, load, ids, revision]);
  useEffect(() => {
    if (!active || !allowed) return;
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); };
  }, [active, allowed, refresh]);
  return { origins: allowed && cache?.owner === owner && cache.mode === accessMode ? cache.origins : EMPTY_ORIGINS, refresh };
}
