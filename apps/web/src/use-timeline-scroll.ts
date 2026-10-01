import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Id } from "@mdc/contracts";

type Position = { top: number; follow: boolean; anchor?: { id: string; offset: number }; ids: Set<string>; unread: boolean };
const BOTTOM_THRESHOLD = 80;

/** UI-only scroll memory. It never selects a context or writes a message. */
export function useTimelineScroll(contextId: Id, itemIds: readonly Id[]) {
  const viewport = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<Id, Position>());
  const active = useRef(contextId); active.current = contextId;
  const [newMessages, setNewMessages] = useState(false);
  const [forceTick, setForceTick] = useState(0);
  const applying = useRef(false);
  const signature = itemIds.join(":");

  const capture = useCallback((id: Id) => {
    const element = viewport.current, state = positions.current.get(id);
    if (!element || !state || active.current !== id || (state.ids.size > 0 && !element.querySelector("[data-item-id]"))) return;
    state.top = element.scrollTop;
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-item-id]")].find(node => node.getBoundingClientRect().bottom > top);
    if (anchor) state.anchor = { id: anchor.dataset.itemId!, offset: anchor.getBoundingClientRect().top - top };
  }, []);
  const apply = useCallback(() => {
    const element = viewport.current, state = positions.current.get(active.current);
    if (!element || !state || (state.ids.size > 0 && !element.querySelector("[data-item-id]"))) return;
    applying.current = true;
    if (state.follow) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    else {
      const anchor = state.anchor && [...element.querySelectorAll<HTMLElement>("[data-item-id]")].find(node => node.dataset.itemId === state.anchor!.id);
      element.scrollTop = anchor
        ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - state.anchor!.offset
        : state.top;
    }
    capture(active.current);
    applying.current = false;
  }, [capture]);
  useLayoutEffect(() => {
    let state = positions.current.get(contextId);
    if (!state) {
      state = { top: 0, follow: true, ids: new Set(itemIds), unread: false };
      positions.current.set(contextId, state);
    } else if (itemIds.length) {
      if (!state.follow && itemIds.some(id => !state!.ids.has(id))) state.unread = true;
      state.ids = new Set(itemIds);
    }
    if (state.follow) state.unread = false;
    setNewMessages(state.unread);
    // A returning context can briefly have no rendered items while its listener
    // reconnects. Keep its previous anchor until those items arrive.
    if (itemIds.length || state.follow) apply();
  }, [contextId, signature, forceTick, apply]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const scroll = () => {
      if (applying.current) return;
      const state = positions.current.get(active.current);
      if (!state || (state.ids.size > 0 && !element.querySelector("[data-item-id]"))) return;
      state.follow = element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_THRESHOLD;
      if (state.follow) { state.unread = false; setNewMessages(false); }
      capture(active.current);
    };
    element.addEventListener("scroll", scroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(apply);
    observer?.observe(element);
    if (content.current) observer?.observe(content.current);
    return () => { element.removeEventListener("scroll", scroll); observer?.disconnect(); };
  }, [apply, capture]);
  const scrollToBottom = useCallback((target: Id = active.current) => {
    if (active.current !== target) return;
    const state = positions.current.get(target);
    if (state) { state.follow = true; state.unread = false; }
    setNewMessages(false); setForceTick(value => value + 1);
  }, []);
  return { viewport, content, newMessages, scrollToBottom };
}
