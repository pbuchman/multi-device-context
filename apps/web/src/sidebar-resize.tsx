import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const DEFAULT_WIDTH = 274;
const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const memory = new Map<string, number>();
const storageKey = (accountId: string) => `mdc-sidebar-width:v1:${encodeURIComponent(accountId)}`;
function readWidth(accountId: string) {
  if (memory.has(accountId)) return memory.get(accountId)!;
  try {
    const saved = localStorage.getItem(storageKey(accountId));
    const width = saved === null ? undefined : Number(saved);
    return width !== undefined && Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH ? width : DEFAULT_WIDTH;
  } catch { return memory.get(accountId) ?? DEFAULT_WIDTH; }
}
function saveWidth(accountId: string, width: number) {
  try { localStorage.setItem(storageKey(accountId), String(width)); memory.delete(accountId); }
  catch { memory.set(accountId, width); }
}

/** Render immediately after the sidebar. The separator overlays its boundary, consuming no panel width. */
export function SidebarResize({ accountId, compact, sidebarRef }: {
  accountId: string; compact: boolean; sidebarRef: RefObject<HTMLElement | null>;
}) {
  // Keying the controller resets both drag state and the preference atomically on account changes.
  return <SidebarResizeController key={accountId} accountId={accountId} compact={compact} sidebarRef={sidebarRef} />;
}
function SidebarResizeController({ accountId, compact, sidebarRef }: {
  accountId: string; compact: boolean; sidebarRef: RefObject<HTMLElement | null>;
}) {
  const [preferred, setPreferred] = useState(() => readWidth(accountId));
  const [available, setAvailable] = useState(window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; original: number; current: number } | null>(null);
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - 360));
  const width = Math.min(max, Math.max(MIN_WIDTH, preferred));
  const clamp = (value: number) => Math.min(max, Math.max(MIN_WIDTH, Math.round(value)));
  useLayoutEffect(() => {
    const container = sidebarRef.current?.parentElement;
    const measure = () => {
      const style = container ? getComputedStyle(container) : undefined;
      const padding = (Number.parseFloat(style?.paddingLeft ?? "0") || 0) + (Number.parseFloat(style?.paddingRight ?? "0") || 0);
      setAvailable((container?.clientWidth || window.innerWidth) - padding);
    };
    measure(); window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (container) observer?.observe(container);
    return () => { window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, [sidebarRef]);
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (sidebar) sidebar.style.width = compact ? "" : `${width}px`;
    return () => { if (sidebar) sidebar.style.width = ""; };
  }, [compact, sidebarRef, width]);
  useLayoutEffect(() => {
    if (compact && drag.current) { setPreferred(drag.current.original); drag.current = null; setDragging(false); }
  }, [compact]);
  const commit = (value: number) => { const next = clamp(value); setPreferred(next); saveWidth(accountId, next); };
  const cancel = () => {
    if (!drag.current) return;
    setPreferred(drag.current.original); drag.current = null; setDragging(false);
  };
  if (compact) return null;
  return <div className={`sidebar-resize${dragging ? " dragging" : ""}`} role="separator" aria-label="Resize chats sidebar" aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
    onDoubleClick={() => commit(DEFAULT_WIDTH)}
    onKeyDown={event => {
      const next = event.key === "ArrowLeft" ? width - 10 : event.key === "ArrowRight" ? width + 10 : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? max : undefined;
      if (event.key === "Escape" && drag.current) { event.preventDefault(); cancel(); }
      if (next !== undefined) { event.preventDefault(); commit(next); }
    }}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, original: preferred, current: width }; setDragging(true);
    }}
    onPointerMove={event => {
      const active = drag.current; if (!active || event.pointerId !== active.pointerId) return;
      active.current = clamp(active.startWidth + event.clientX - active.startX); setPreferred(active.current);
    }}
    onPointerUp={event => {
      const active = drag.current; if (!active || event.pointerId !== active.pointerId) return;
      commit(active.current); drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
  />;
}
