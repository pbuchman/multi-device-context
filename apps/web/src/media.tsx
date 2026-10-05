import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { Content, Id, NativeFile } from "@mdc/contracts";
import { ContentSchema, MAX_ATTACHMENT_BYTES } from "@mdc/contracts";
import type { ItemRecord } from "./model.js";
import { trapFocus } from "./workspace-overlay.js";
type Attachment = Extract<Content, { kind: "attachment" }>;
type Cloud = { attachmentBytes(contextId: Id, itemId: Id, content: Attachment): Promise<Uint8Array> };
const downloads = new WeakMap<Cloud, Map<string, Promise<Uint8Array>>>();
function download(cloud: Cloud, item: ItemRecord, content: Attachment) {
  let active = downloads.get(cloud); if (!active) { active = new Map(); downloads.set(cloud, active); }
  const key = `${item.contextId}/${item.id}/${content.contentType}/${content.size}`;
  let pending = active.get(key);
  if (!pending) { pending = cloud.attachmentBytes(item.contextId, item.id, content); active.set(key, pending); void pending.finally(() => active!.delete(key)).catch(() => {}); }
  return pending;
}
type MenuState = { x: number; y: number; opener: HTMLElement };

function ImageContextMenu({ state, onCopy, onClose }: { state: MenuState; onCopy(): void; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: state.x, y: state.y });
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useLayoutEffect(() => {
    const menu = root.current!;
    const place = () => {
      const { width, height } = menu.getBoundingClientRect();
      setPosition({ x: Math.max(8, Math.min(state.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(state.y, window.innerHeight - height - 8)) });
    };
    place(); menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) closeRef.current(); };
    document.addEventListener("pointerdown", outside, true); window.addEventListener("resize", place);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", place); };
  }, [state.x, state.y]);
  const close = () => { closeRef.current(); if (state.opener.isConnected) state.opener.focus({ preventScroll: true }); };
  return createPortal(<div ref={root} className="image-context-menu" role="menu" aria-label="Image actions" style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (["Escape", "Tab", "ContextMenu"].includes(event.key) || (event.shiftKey && event.key === "F10")) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); root.current?.querySelector<HTMLButtonElement>("button")?.click(); }
  }}><button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(); onCopy(); }}>Copy image</button></div>, document.body);
}

function ImageOverlay({ url, name, opener, onCopy, onClose, onContextMenu }: { url: string; name: string; opener: HTMLElement; onCopy(): void; onClose(): void; onContextMenu(event: ReactMouseEvent<HTMLElement>): void }) {
  const panel = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useLayoutEffect(() => {
    const shell = opener.closest<HTMLElement>(".app-shell"); if (shell) shell.inert = true;
    closeButton.current?.focus({ preventScroll: true });
    return () => { if (shell) shell.inert = false; if (opener.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      else if (panel.current) trapFocus(event, panel.current);
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  return createPortal(<div className="image-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="image-overlay-panel" role="dialog" aria-modal="true" aria-label={`Image preview: ${name}`}>
      <div className="image-overlay-toolbar"><span title={name}>{name}</span><button type="button" onClick={onCopy}>Copy image</button><button ref={closeButton} type="button" aria-label="Close image preview" onClick={onClose}>×</button></div>
      <div className="image-overlay-canvas" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><img src={url} alt={name} tabIndex={0} onContextMenu={onContextMenu} /></div>
    </section>
  </div>, document.body);
}

export function AttachmentPreview({ item, cloud, onCopy, blocked = false }: { item: ItemRecord; cloud: Cloud; onCopy?: (() => void) | undefined; blocked?: boolean }) {
  const content = item.content.kind === "attachment" ? item.content : undefined;
  const type = content?.contentType, size = content?.size, name = content?.name;
  const renderable = !!content && item.ready && type !== "image/svg+xml" && /^(image|audio|video)\//.test(type!);
  const [url, setUrl] = useState<string>();
  const [open, setOpen] = useState(false), [menu, setMenu] = useState<MenuState>();
  const thumbnail = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setUrl(undefined); if (!renderable || !content) return;
    let disposed = false, objectUrl: string | undefined;
    void download(cloud, item, content).then(bytes => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: type! })); setUrl(objectUrl);
    }).catch(() => {});
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [cloud, item.contextId, item.id, renderable, type, size]);
  if (!url || !renderable) return null;
  if (type!.startsWith("image/")) {
    const openMenu = (event: ReactMouseEvent<HTMLElement>) => { if (!onCopy || blocked) return; event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, opener: event.currentTarget }); };
    const keyboardMenu = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!onCopy || blocked || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, opener: event.currentTarget });
    };
    return <><button ref={thumbnail} type="button" className="image-preview-trigger" aria-label={`Open image ${name}`} aria-haspopup="dialog" disabled={blocked} onClick={() => setOpen(true)} onContextMenu={openMenu} onKeyDown={keyboardMenu}><img className="attachment-preview" src={url} alt="" /></button>
      {open && thumbnail.current ? <ImageOverlay url={url} name={name!} opener={thumbnail.current} onCopy={() => onCopy?.()} onClose={() => { setMenu(undefined); setOpen(false); }} onContextMenu={openMenu} /> : null}
      {menu && onCopy ? <ImageContextMenu state={menu} onCopy={onCopy} onClose={() => setMenu(undefined)} /> : null}</>;
  }
  if (type!.startsWith("audio/")) return <audio className="attachment-preview" src={url} controls />;
  return <video className="attachment-preview" src={url} controls />;
}
export async function fileParts(files: File[] | NativeFile[]): Promise<{ content: Content; bytes: Uint8Array }[]> {
  const browser = (file: File | NativeFile): file is File => typeof File !== "undefined" && file instanceof File;
  const sizes = files.map(file => browser(file) ? file.size : file.bytes.byteLength);
  if (files.length > 32 || sizes.some(size => size < 1 || size > MAX_ATTACHMENT_BYTES) || sizes.reduce((a,b) => a+b,0) > MAX_ATTACHMENT_BYTES) throw new Error("Choose up to 32 non-empty files, at most 100 MiB in total.");
  const metadata = files.map((file, i) => ContentSchema.parse({ kind: "attachment", name: file.name, contentType: (browser(file) ? file.type : file.contentType) || "application/octet-stream", size: sizes[i] }));
  const parts = [];
  for (const [i, file] of files.entries()) parts.push({ content: metadata[i]!, bytes: browser(file) ? new Uint8Array(await file.arrayBuffer()) : file.bytes });
  return parts;
}
export function dayLabel(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp), yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}
