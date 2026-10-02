import { useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import type { ContextRecord, ItemRecord } from "./model.js";
import type { WorkspaceCloud } from "./App.js";
import { AttachmentPreview } from "./media.js";

const paths = {
  menu: "M4 7h16M4 16h11", close: "m6 6 12 12M18 6 6 18", plus: "M12 5v14M5 12h14",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2",
  copy: "M8 8h12v12H8zM15 8V4H4v11h4", send: "M12 19V5M6 11l6-6 6 6",
  paste: "M8 5H5v16h14V5h-3M8 2h8v5H8z", search: "M17 17l4 4M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  edit: "M13 5H5v14h14v-8M10 14l1-4 8-8 3 3-8 8-4 1Z", stack: "M4 4h12v12H4zM9 20h11V9",
  file: "M6 2h8l4 4v16H6zM14 2v5h4M9 12h6M9 16h5", save: "M12 3v12M7 10l5 5 5-5M4 17v4h16v-4",
  share: "M9 6h12v12M21 6 9 18M15 3H3v18h12", code: "m7 6-6 6 6 6M17 6l6 6-6 6M14 3l-4 18",
  trash: "M3 5h18M9 5V2h6v3M5 5l1 16h12l1-16M10 9v8M14 9v8", link: "m9 15 6-6M8 8l3-3a5 5 0 0 1 7 7l-2 2M16 16l-3 3a5 5 0 0 1-7-7l2-2",
  settings: "m10 3 1-2h2l1 2 2 1 2-1 2 2-1 2 1 2 2 1v2l-2 1-1 2 1 2-2 2-2-1-2 1-1 2h-2l-1-2-2-1-2 1-2-2 1-2-1-2-2-1v-2l2-1 1-2-1-2 2-2 2 1 2-1M15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
} as const;
export type IconName = keyof typeof paths | "more";
export function WorkspaceIcon({ name }: { name: IconName }) {
  return <svg className="workspace-icon" viewBox="0 0 24 24" aria-hidden="true">{name === "more" ? <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></> : <path d={paths[name]} />}</svg>;
}
export function displayTitle(title?: string) { return !title || title === "New context" ? "New chat" : title; }
export function formatFileSize(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }

export function ChatSidebar({ elementRef, compact, open, contexts, selectedId, search, onSearch, onSelect, onNew, onClose, onOptions, onSettings, onRefresh, refreshing, blocked, name }: {
  elementRef: RefObject<HTMLElement | null>; compact: boolean; open: boolean; contexts: ContextRecord[]; selectedId: string; search: string; onSearch(value: string): void;
  onSelect(id: string): void; onNew(): void; onClose(): void; onOptions(context: ContextRecord): void; onSettings(): void; onRefresh(): void; refreshing: boolean; blocked: boolean; name: string;
}) {
  return <aside ref={elementRef} className="sidebar" aria-label="Chats sidebar" role={compact && open ? "dialog" : undefined} aria-modal={compact && open ? true : undefined}>
    <div className="brand"><span className="brand-mark"><WorkspaceIcon name="stack" /></span><span>Multi Device Context<small>Chat with yourself</small></span><button type="button" className="icon-button drawer-close" aria-label="Close chats menu" onClick={onClose}><WorkspaceIcon name="close" /></button></div>
    <button type="button" className="new-context" aria-label="New chat" onClick={onNew} disabled={blocked}><WorkspaceIcon name="edit" />New chat</button>
    <div className="search"><WorkspaceIcon name="search" /><input type="search" aria-label="Search chat titles" placeholder="Search chats" value={search} onChange={event => onSearch(event.target.value)} /><button className="icon-button" aria-label="Clear search" onClick={() => onSearch("")}><WorkspaceIcon name="close" /></button></div>
    <div className="context-list-wrap"><div className="sidebar-label"><span>Your chats</span><button className="icon-button" type="button" aria-label="Refresh chats and messages" disabled={refreshing || blocked} aria-busy={refreshing} onClick={onRefresh}><WorkspaceIcon name="refresh" /></button></div>
      <nav className="context-list" aria-label="Your chats">{contexts.length ? contexts.map(context => <div className={`context-row ${context.id === selectedId ? "selected" : ""}`} key={context.id}>
        <button type="button" className="context-select" title={displayTitle(context.title)} aria-label={context.title === "New context" ? "Open new chat" : displayTitle(context.title)} aria-description={context.unread ? "Unread messages" : undefined} aria-current={context.id === selectedId ? "page" : undefined} onClick={() => onSelect(context.id)} disabled={blocked}><span>{displayTitle(context.title)}</span>{context.unread ? <i aria-hidden="true" /> : null}</button>
        <button type="button" className="icon-button" aria-label={`Options for ${displayTitle(context.title)}`} onClick={() => onOptions(context)} disabled={blocked}><WorkspaceIcon name="more" /></button>
      </div>) : <p className="no-results">No chats match this title. Clear your search to see all chats.</p>}</nav>
    </div>
    <div className="sidebar-footer"><button type="button" className="account" aria-label="Open settings" onClick={onSettings} disabled={blocked}><span className="avatar">{name.charAt(0).toUpperCase()}</span><span>Settings<small>{name}</small></span><WorkspaceIcon name="settings" /></button></div>
  </aside>;
}

export function ChatTopbar({ title, status, offline, drawerOpen, menuRef, onMenu, onRefresh, onOptions, refreshing, blocked }: {
  title?: string | undefined; status: string; offline: boolean; drawerOpen: boolean; menuRef: RefObject<HTMLButtonElement | null>; onMenu(): void; onRefresh(): void; onOptions(): void; refreshing: boolean; blocked: boolean;
}) {
  return <header className="titlebar"><button ref={menuRef} className="icon-button menu-button" aria-label="Open chats menu" aria-expanded={drawerOpen} disabled={blocked} onClick={onMenu}><WorkspaceIcon name="menu" /></button>
    <div className="title-group"><h1 tabIndex={-1} title={displayTitle(title)}>{displayTitle(title)}</h1><small><span className={`status-dot ${offline ? "offline" : ""}`} />{status}</small></div>
    <button type="button" className="icon-button refresh" aria-label="Refresh" title="Refresh chats and messages" aria-description="Refresh chats, messages, and deletions" disabled={refreshing || blocked} aria-busy={refreshing} onClick={onRefresh}><WorkspaceIcon name="refresh" /></button>
    <button type="button" className="icon-button" aria-label="Chat options" disabled={blocked} onClick={onOptions}><WorkspaceIcon name="more" /></button>
  </header>;
}

export function ChatMessage({ item, cloud, onCopy, onMore, blocked }: { item: ItemRecord; cloud: WorkspaceCloud; onCopy(item: ItemRecord): void; onMore(item: ItemRecord): void; blocked: boolean }) {
  const attachment = item.content.kind === "attachment" ? item.content : undefined;
  const text = item.content.kind !== "attachment" ? item.content.text : "";
  const isUrl = item.content.kind === "text" && /^https?:\/\/\S+$/.test(text);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(item.createdAt);
  return <article className="item-card" data-item-id={item.id}>
    {item.content.kind === "code" ? <div className="code-card"><div className="code-label">Code</div><pre>{text}</pre></div>
      : attachment ? <div className="file-card"><AttachmentPreview item={item} cloud={cloud} /><div className="file-detail"><WorkspaceIcon name="file" /><span title={attachment.name}>{attachment.name}<small>{formatFileSize(attachment.size)} · {item.ready ? attachment.contentType : "Uploading"}</small></span></div></div>
        : isUrl ? <a className="text-card link-card" href={text} target="_blank" rel="noreferrer">{text}</a> : <div className="text-card">{text}</div>}
    <div className="item-actions"><span className="item-meta" title={`${item.device.name} · ${time}`}>{item.syncState === "pending" ? "Pending · " : item.syncState === "failed" || item.syncState === "paused" ? "Not sent · " : ""}{item.device.name} · {time}</span>
      <button type="button" className="icon-button" aria-label={attachment ? `Copy ${attachment.name}` : "Copy message"} title="Copy to this device" disabled={blocked || (!!attachment && !item.ready)} onClick={() => onCopy(item)}><WorkspaceIcon name="copy" /></button>
      <button type="button" className="icon-button" aria-label={attachment ? `Options for ${attachment.name}` : "Message options"} disabled={blocked} onClick={() => onMore(item)}><WorkspaceIcon name="more" /></button>
    </div>
  </article>;
}

export function ChatComposer({ text, code, android, nativeClipboard, blocked, sending, textareaRef, onText, onPaste, onKey, onAdd, onCodeOff, onFastPaste, onSend }: {
  text: string; code: boolean; android: boolean; nativeClipboard: boolean; blocked: boolean; sending: boolean; textareaRef: RefObject<HTMLTextAreaElement | null>;
  onText(value: string): void; onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void; onKey(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onAdd(): void; onCodeOff(): void; onFastPaste(): void; onSend(): void;
}) {
  useLayoutEffect(() => {
    const element = textareaRef.current; if (!element) return;
    const grow = () => { element.style.height = "auto"; element.style.height = `${Math.max(48, Math.min(element.scrollHeight, 160, (window.visualViewport?.height ?? window.innerHeight) * 0.25))}px`; };
    grow(); window.addEventListener("resize", grow); return () => window.removeEventListener("resize", grow);
  }, [text, code, textareaRef]);
  return <div className="composer-wrap"><div className={`composer ${code ? "code-mode" : ""}`}>
    {code ? <div className="code-indicator"><span>Code mode</span><button type="button" className="icon-button" aria-label="Turn off code mode" disabled={blocked} onClick={onCodeOff}><WorkspaceIcon name="close" /></button></div> : null}
    <textarea ref={textareaRef} rows={2} value={text} aria-label="Message to yourself" placeholder={code ? "Write or paste code…" : "Message yourself…"} disabled={blocked} onChange={event => onText(event.target.value)} onPaste={onPaste} onKeyDown={onKey} />
    <div className="composer-tools"><button type="button" className="icon-button" aria-label="Add files or code" aria-haspopup="dialog" disabled={blocked} onClick={onAdd}><WorkspaceIcon name="plus" /></button>
      {nativeClipboard ? <button type="button" className="paste-send" disabled={blocked} onClick={onFastPaste}><WorkspaceIcon name="paste" />Paste and send</button> : null}
      <button type="button" className="send" aria-label="Send" title="Send message" disabled={blocked || sending || !text.length} onClick={onSend}><WorkspaceIcon name="send" /></button>
    </div>
  </div><div className="composer-note">{android ? "Chat with yourself · Your devices" : code ? "Enter for a new line · Ctrl/⌘+Enter to send" : "Enter to send · Shift+Enter for a new line"}</div></div>;
}
