import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./chat-context-menu.css";

export interface ChatMenuAnchor { x: number; y: number }
export function ChatContextMenu<T extends { id: string; title: string }>({ context, anchor, opener, onClose, onRename, onCopy, onDelete }: {
  context: T; anchor: ChatMenuAnchor; opener: HTMLElement;
  onClose(): void; onRename(context: T): void; onCopy?: ((context: T) => void) | undefined; onDelete(context: T): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const restore = () => { if (opener.isConnected) opener.focus({ preventScroll: true }); };
  const close = () => { restore(); closeRef.current(); };
  useLayoutEffect(() => {
    const menu = root.current!;
    const place = () => {
      const { width, height } = menu.getBoundingClientRect();
      setPosition({ x: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8)) });
    };
    place(); menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) { if (opener.isConnected) opener.focus({ preventScroll: true }); closeRef.current(); } };
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside, true);
      if ((menu.contains(document.activeElement) || document.activeElement === document.body) && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [anchor.x, anchor.y, context.id, opener]);
  const activate = (action: (context: T) => void) => { close(); action(context); };
  return createPortal(<div ref={root} className="chat-context-menu" role="menu" aria-label={`Options for ${context.title}`} style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (["Escape", "Tab", "ContextMenu"].includes(event.key) || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopPropagation(); buttons[index]?.click();
    }
  }}>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => activate(onRename)}>Rename chat</button>
    {onCopy ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => activate(onCopy)}>Copy link</button> : null}
    <button type="button" role="menuitem" tabIndex={-1} className="chat-context-menu-delete" onClick={() => activate(onDelete)}>Delete chat…</button>
  </div>, document.body);
}
