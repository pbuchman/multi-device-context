import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

const focusable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex="0"]')].filter(element => !element.hasAttribute("disabled") && !element.hidden && !element.closest('[hidden],[inert]'));
export function trapFocus(event: KeyboardEvent, root: HTMLElement) {
  if (event.key !== "Tab") return;
  const candidates = focusable(root);
  const first = candidates[0], last = candidates.at(-1);
  if (!first || !last) { event.preventDefault(); root.focus(); return; }
  const active = document.activeElement;
  if (!candidates.includes(active as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}

export function WorkspaceDialog({ title, description, viewKey, children, onClose, backgroundRef, onConfirm, busy = false }: {
  title: string; description?: string; viewKey: string; children: ReactNode; onClose(): void;
  backgroundRef: RefObject<HTMLElement | null>; busy?: boolean; onConfirm?: (() => void) | undefined;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const background = backgroundRef.current;
    if (background) background.inert = true;
    return () => { if (background) background.inert = false; };
  }, [backgroundRef]);
  useLayoutEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [viewKey]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (panel.current) trapFocus(event, panel.current); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) close.current(); }}>
    <section ref={panel} className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title" aria-describedby={description ? "workspace-dialog-description" : undefined} aria-busy={busy} onKeyDown={event => {
      if (!onConfirm || busy || event.key !== "Enter" || event.repeat || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      // Focused controls retain their native Enter behavior (especially Cancel).
      if ((event.target as HTMLElement).closest('button,input,textarea,select,a,[contenteditable="true"]')) return;
      event.preventDefault(); event.stopPropagation(); onConfirm();
    }}>
      <div className="dialog-handle" aria-hidden="true" />
      <div className="dialog-heading"><h2 ref={titleRef} tabIndex={-1} id="workspace-dialog-title">{title}</h2><button className="icon-button" type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button></div>
      {description ? <p id="workspace-dialog-description" className="dialog-description">{description}</p> : null}
      {children}
    </section>
  </div>;
}
