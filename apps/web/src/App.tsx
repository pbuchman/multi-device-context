import type { ClipboardSnapshot, Content, Device, Id, NativeFile, PendingClipboardShare } from "@mdc/contracts";
import { ContentSchema, IdSchema, MAX_ATTACHMENT_BYTES } from "@mdc/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useNavigation } from "./navigation.js";
import { AgentKeys, type AgentKeyClient } from "./AgentKeys.js";

import { SessionManager, type ActiveSession } from "./auth.js";
import { FirebaseCloud, type CloudSnapshot } from "./cloud.js";
import { drainNativeClipboardQueue, type NativeQueueStore } from "./desktop.js";
import type { ContextRecord, ItemRecord, ShareDraft, Viewer } from "./model.js";
import { DurableOutbox, OutboxRunner, type QueuedShare } from "./outbox.js";
import "./theme.css";

type Unsubscribe = () => void;

export type WorkspaceCloud = {
  subscribeDeletedContexts?(emit: (ids: Id[]) => void, fail: (error: Error) => void): Unsubscribe;
  subscribeContexts(emit: (snapshot: CloudSnapshot<ContextRecord>) => void, fail: (error: Error) => void): Unsubscribe;
  subscribeItems(contextId: Id, emit: (snapshot: CloudSnapshot<ItemRecord>) => void, fail: (error: Error) => void): Unsubscribe;
  renameContext(contextId: Id, title: string): Promise<void>;
  deleteContext(contextId: Id): Promise<void>;
  deleteItem(contextId: Id, itemId: Id): Promise<void>;
  attachmentBytes(contextId: Id, itemId: Id, content: Extract<Content, { kind: "attachment" }>): Promise<Uint8Array>;
};

export type WorkspaceOutbox = {
  readonly namespace: string;
  removeContext?(id: Id): Promise<void>;
  enqueue(draft: ShareDraft): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
  retry(key?: string): Promise<void>;
  list(): Promise<QueuedShare[]>;
};

export type WorkspaceServices = {
  initialContextId?: Id;
  agentKeys?: AgentKeyClient;
  isDesktop?: boolean;
  subscribeNavigation?: (listener: (id?: Id) => void) => Unsubscribe;
  viewer: Viewer;
  device: Device;
  cloud: WorkspaceCloud;
  outbox: WorkspaceOutbox;
  drain(): Promise<void>;
  copyText(text: string): Promise<void>;
  copyFile(file: NativeFile): Promise<void>;
  saveFile(file: NativeFile): Promise<boolean>;
  signOut(): Promise<void>;
  getLaunchAtLogin?: () => Promise<boolean>;
  setLaunchAtLogin?: (enabled: boolean) => Promise<void>;
  pendingNativeCount?: () => Promise<number>;
  readClipboard?: () => Promise<ClipboardSnapshot>;
  subscribeNativeShares?: (listener: () => void) => Unsubscribe;
  drainNativeShares?: () => Promise<Id | undefined>;
};

type SharePart = { content: Content; bytes?: Uint8Array };
type Theme = "system" | "light" | "dark";

function newId(): Id { return IdSchema.parse(crypto.randomUUID()); }

function readConfirmedContexts(key: string): ReadonlySet<Id> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(stored)) return new Set(stored.filter((id): id is Id => IdSchema.safeParse(id).success));
  } catch { /* A missing or unavailable cache must not prevent sharing. */ }
  return new Set();
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function deriveTitle(content: Content): string {
  const candidate = content.kind === "attachment" ? content.name : content.text.split(/\r?\n/, 1)[0]!.trim();
  return (candidate || (content.kind === "code" ? "Code snippet" : "Shared note")).slice(0, 160);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function Icon({ children }: { children: ReactNode }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

function AttachmentPreview({ item, cloud }: { item: ItemRecord; cloud: WorkspaceCloud }) {
  const [url, setUrl] = useState<string>();
  const content = item.content.kind === "attachment" ? item.content : undefined;
  const renderable = content && item.ready && content.contentType !== "image/svg+xml"
    && /^(image|audio|video)\//.test(content.contentType);
  useEffect(() => {
    if (!content || !renderable) return;
    let revoked = false;
    let objectUrl: string | undefined;
    void cloud.attachmentBytes(item.contextId, item.id, content).then((bytes) => {
      if (revoked) return;
      objectUrl = URL.createObjectURL(new Blob([bytesBuffer(bytes)], { type: content.contentType }));
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cloud, content, item.contextId, item.id, renderable]);
  if (!content || !renderable || !url) return null;
  if (content.contentType.startsWith("image/")) return <img className="attachment-preview" src={url} alt={content.name} />;
  if (content.contentType.startsWith("audio/")) return <audio className="attachment-preview" src={url} controls />;
  return <video className="attachment-preview" src={url} controls />;
}

function ItemCard({
  item, cloud, onCopy, onSave, onDelete,
}: {
  item: ItemRecord;
  cloud: WorkspaceCloud;
  onCopy(item: ItemRecord): void;
  onSave(item: ItemRecord): void;
  onDelete(item: ItemRecord): void;
}) {
  const attachment = item.content.kind === "attachment" ? item.content : undefined;
  const textContent = item.content.kind !== "attachment" ? item.content : undefined;
  const isUrl = textContent?.kind === "text" && /^https?:\/\/\S+$/.test(textContent.text);
  return (
    <article className="item-card">
      <div className="item-meta"><Icon>▣</Icon>{item.device.name} · {formatTime(item.createdAt)}</div>
      {item.content.kind === "code" ? (
        <div className="code-card"><div className="code-label">Code <Icon>&lt;/&gt;</Icon></div><pre>{item.content.text}</pre></div>
      ) : attachment ? (
        <div className="file-card">
          <AttachmentPreview item={item} cloud={cloud} />
          <div className="file-detail"><Icon>▧</Icon><span>{attachment.name}<small>{formatBytes(attachment.size)} · {item.ready ? attachment.contentType : "Uploading"}</small></span></div>
        </div>
      ) : isUrl ? (
        <a className="text-card link-card" href={textContent!.text} target="_blank" rel="noreferrer">{textContent!.text}</a>
      ) : <div className="text-card">{textContent?.text}</div>}
      <div className="item-actions">
        <button type="button" onClick={() => onCopy(item)}><Icon>⧉</Icon>Copy</button>
        {attachment ? <button type="button" onClick={() => onSave(item)} disabled={!item.ready}><Icon>↓</Icon>Save</button> : null}
        <button type="button" className="danger-quiet" aria-label={`Delete ${attachment?.name ?? "item"}`} onClick={() => onDelete(item)}><Icon>×</Icon></button>
      </div>
    </article>
  );
}

export function ContextWorkspace({ services }: { services: WorkspaceServices }) {
  const [contexts, setContexts] = useState<ContextRecord[]>([]);
  const confirmedKey = `mdc-confirmed:${services.outbox.namespace}`;
  const [confirmedContextIds, setConfirmedContextIds] = useState(() => readConfirmedContexts(confirmedKey));
  const navigation = useNavigation(services.outbox.namespace, services.initialContextId);
  const { selectedId, select: setSelectedId, draftContext, text, codeMode } = navigation;
  const setText = (text: string) => navigation.patch({ text });
  const setCodeMode = (change: (value: boolean) => boolean) => navigation.patch({ code: change(codeMode) });
  const setDraftContext = (context?: ContextRecord) => navigation.patch(context ? { title: context.title } : { local: false });
  const [items, setItems] = useState<ItemRecord[]>([]);
  const [optimisticItems, setOptimisticItems] = useState<ItemRecord[]>([]);
  const [search, setSearch] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [queueCount, setQueueCount] = useState(0);
  const [fromCache, setFromCache] = useState(false);
  const [pendingWrites, setPendingWrites] = useState(false);
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("mdc-theme") as Theme | null) ?? "system");
  const [launchAtLogin, setLaunchAtLoginState] = useState<boolean>();
  const fileInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const localQueuedContexts = useRef(new Set<Id>());
  const readKey = `mdc-read:${services.viewer.uid}:${services.device.id}`;
  const lastRead = useRef<Record<string, number>>((() => {
    try { return JSON.parse(localStorage.getItem(readKey) ?? "{}"); } catch { return {}; }
  })());

  const showToast = useCallback((message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(undefined), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  useEffect(() => {
    try { localStorage.setItem(confirmedKey, JSON.stringify([...confirmedContextIds])); }
    catch { /* Firestore still verifies ownership when the listener connects. */ }
  }, [confirmedContextIds, confirmedKey]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mdc-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!services.getLaunchAtLogin) return;
    void services.getLaunchAtLogin().then(setLaunchAtLoginState).catch(() => setError("Could not read the startup setting"));
  }, [services]);

  const seenContexts = useRef<Set<Id> | undefined>(undefined);
  const acknowledged = useRef(new Set<Id>());
  const deleted = useRef(new Set<Id>());
  useEffect(() => services.cloud.subscribeContexts((snapshot) => {
    setConfirmedContextIds((current) => {
      const confirmed = snapshot.records.filter(context => (context.syncState === "synced" || context.syncState === "cached") && !current.has(context.id));
      return confirmed.length ? new Set([...current, ...confirmed.map(context => context.id)]) : current;
    });
    const currentId = navigation.selectedRef.current.id;
    for (const context of snapshot.records) localQueuedContexts.current.delete(context.id);
    setContexts(snapshot.records.filter(c => !deleted.current.has(c.id)).map(context => ({ ...context, unread: context.id !== currentId && context.updatedAt > (lastRead.current[context.id] ?? context.createdAt) })));
    setFromCache(snapshot.fromCache); setPendingWrites(snapshot.hasPendingWrites);
    if (!snapshot.fromCache) {
      const ready = snapshot.records.filter(c => c.syncState === "synced" && c.ready !== false);
      if (seenContexts.current) {
        const incoming = ready.filter(c => !seenContexts.current!.has(c.id) && c.originDeviceId !== services.device.id && !localQueuedContexts.current.has(c.id))
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        if (incoming[0]) setSelectedId(incoming[0].id);
      } else seenContexts.current = new Set();
      for (const context of ready) seenContexts.current.add(context.id);
      for (const context of snapshot.records) acknowledged.current.add(context.id);
      if (acknowledged.current.has(currentId) && !snapshot.records.some(c => c.id === currentId) && !localQueuedContexts.current.has(currentId)) setSelectedId(undefined);
      else if (!navigation.selectedRef.current.drafts[currentId]?.local && !snapshot.records.some(c => c.id === currentId) && !localQueuedContexts.current.has(currentId)) setError("This context is unavailable or has been deleted");
    }
  }, cause => setError(cause.message || "Could not load contexts")), [services.cloud, services.device.id, setSelectedId]);

  useEffect(() => services.cloud.subscribeDeletedContexts?.(ids => {
    for (const id of ids) deleted.current.add(id);
    navigation.remove(ids);
    setContexts(current => current.filter(c => !deleted.current.has(c.id)));
    setOptimisticItems(current => current.filter(item => !deleted.current.has(item.contextId)));
    setConfirmedContextIds(current => new Set([...current].filter(id => !deleted.current.has(id))));
    for (const id of ids) { localQueuedContexts.current.delete(id); void services.outbox.removeContext?.(id).catch(() => setError("Could not remove local pending shares")); }
    if (deleted.current.has(navigation.selectedRef.current.id)) setSelectedId(undefined);
  }, () => setError("Could not synchronize deletions")), [services.cloud, services.outbox, navigation.remove, setSelectedId]);

  useEffect(() => services.subscribeNavigation?.(id => { setSelectedId(id); setError(undefined); setMenuOpen(false); setRenaming(false); }), [services, setSelectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const selected = contexts.find((context) => context.id === selectedId);
    if (!selected) return;
    lastRead.current[selectedId] = selected.updatedAt;
    localStorage.setItem(readKey, JSON.stringify(lastRead.current));
    if (selected.unread) setContexts((current) => current.map((context) => context.id === selectedId ? { ...context, unread: false } : context));
  }, [contexts, readKey, selectedId]);

  const selectedContextConfirmed = selectedId !== undefined && confirmedContextIds.has(selectedId);
  useEffect(() => {
    if (!selectedId || !selectedContextConfirmed) { setItems([]); return; }
    return services.cloud.subscribeItems(selectedId, (snapshot) => {
      setItems(snapshot.records);
      setFromCache(snapshot.fromCache);
      setPendingWrites(snapshot.hasPendingWrites);
      const cloudIds = new Set(snapshot.records.map((item) => item.id));
      setOptimisticItems((current) => current.filter((item) => item.contextId !== selectedId || !cloudIds.has(item.id)));
    }, (cause) => setError(cause.message || "Could not load shared items"));
  }, [selectedContextConfirmed, selectedId, services.cloud]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); setSettingsOpen(false); setRenaming(false); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const allContexts = [...navigation.localContexts, ...contexts.filter(context => !navigation.localContexts.some(draft => draft.id === context.id))];
  const selected = allContexts.find((context) => context.id === selectedId);
  const visibleContexts = allContexts.filter((context) => context.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const visibleItems = [...items.filter(item => item.contextId === selectedId), ...optimisticItems.filter((item) => item.contextId === selectedId)]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  const restoreQueued = useCallback(async (selectContext?: Id, selectLatestNative = false) => {
    const queued = await services.outbox.list();
    if (selectLatestNative) {
      selectContext = queued.filter((record) => record.nativeRequestId)
        .sort((left, right) => right.queuedAt - left.queuedAt)[0]?.contextId;
    }
    if (selectContext) setSelectedId(selectContext);
    if (queued.length === 0) return;
    const queuedContexts = new Map<Id, ContextRecord>();
    for (const record of queued) {
      localQueuedContexts.current.add(record.contextId);
      queuedContexts.set(record.contextId, {
      id: record.contextId,
      title: record.title,
      createdAt: record.queuedAt,
      updatedAt: record.queuedAt,
      syncState: record.status === "paused" ? "paused" : record.status === "failed" ? "failed" : "pending",
      });
    }
    setContexts((current) => {
      const existing = new Set(current.map((context) => context.id));
      return [...queuedContexts.values()].filter((context) => !existing.has(context.id)).concat(current);
    });
    setOptimisticItems(queued.map((record) => ({
      id: record.itemId,
      contextId: record.contextId,
      content: record.content,
      device: record.device,
      createdAt: record.queuedAt,
      ready: record.content.kind !== "attachment",
      syncState: record.status === "paused" ? "paused" : record.status === "failed" ? "failed" : "pending",
    })));
  }, [services.outbox]);

  const refreshQueue = useCallback(async () => {
    const queued = await services.outbox.list();
    setQueueCount(queued.length);
    const failed = queued.find((record) => record.status === "paused" || record.status === "failed");
    if (failed?.lastError) setError(failed.lastError);
  }, [services.outbox]);
  useEffect(() => { void refreshQueue(); }, [refreshQueue]);
  useEffect(() => {
    if (queueCount === 0) return;
    const timer = window.setInterval(() => void refreshQueue(), 2_000);
    return () => window.clearInterval(timer);
  }, [queueCount, refreshQueue]);
  useEffect(() => {
    let active = true;
    void restoreQueued().catch(() => { if (active) setError("Pending shares could not be restored"); });
    return () => { active = false; };
  }, [restoreQueued]);
  useEffect(() => {
    if (!services.subscribeNativeShares || !services.drainNativeShares) return;
    return services.subscribeNativeShares(() => {
      void services.drainNativeShares!()
        .then((contextId) => restoreQueued(contextId))
        .then(refreshQueue)
        .catch((cause: unknown) => {
          void restoreQueued(undefined, true).then(refreshQueue).then(services.drain);
          setError(cause instanceof Error ? cause.message : "Clipboard sharing failed");
        });
    });
  }, [refreshQueue, restoreQueued, services]);

  const share = useCallback(async (parts: SharePart[], forcedContextId?: Id, sentText?: string) => {
    if (parts.length === 0) return;
    const contextId = forcedContextId ?? selectedId ?? newId();
    const createsContext = !contexts.some((context) => context.id === contextId);
    const localTitle = navigation.selectedRef.current.drafts[contextId]?.title;
    const manualTitle = Boolean(createsContext && localTitle && localTitle !== "New context");
    const title = manualTitle ? localTitle! : deriveTitle(parts[0]!.content);
    const now = Date.now();
    try {
      const drafts = parts.map((part, index): ShareDraft => ({
        contextId,
        itemId: newId(),
        title,
        content: ContentSchema.parse(part.content),
        device: services.device,
        createsContext: createsContext && index === 0,
        ...(manualTitle ? { manualTitle: true } : {}),
        ...(part.bytes ? { bytes: part.bytes } : {}),
      }));
      for (const draft of drafts) await services.outbox.enqueue(draft);
      navigation.commit(contextId, sentText);
      if (createsContext) {
        localQueuedContexts.current.add(contextId);
        setContexts((current) => [{ id: contextId, title, createdAt: now, updatedAt: now, syncState: "pending" }, ...current]);
      }
      if (navigation.selectedRef.current.id === selectedId || forcedContextId) setSelectedId(contextId);
      setOptimisticItems((current) => [...current, ...drafts.map((draft, index) => ({
        id: draft.itemId,
        contextId,
        content: draft.content,
        device: draft.device,
        createdAt: now + index,
        ready: draft.content.kind !== "attachment",
        syncState: "pending" as const,
      }))]);
      await refreshQueue();
      void services.drain().then(refreshQueue).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Sharing failed"));
      showToast("Shared · syncing to your other devices");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This item could not be shared");
    }
  }, [contexts, refreshQueue, selectedId, services, showToast]);

  const shareFiles = useCallback(async (files: File[] | NativeFile[], forcedContextId?: Id) => {
    const parts: SharePart[] = [];
    for (const file of files) {
      const isBrowserFile = file instanceof File;
      const bytes = isBrowserFile ? new Uint8Array(await file.arrayBuffer()) : file.bytes;
      const contentType = isBrowserFile ? file.type : file.contentType;
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} must be between 1 byte and 100 MB`);
        continue;
      }
      parts.push({
        content: { kind: "attachment", name: file.name, contentType: contentType || "application/octet-stream", size: bytes.byteLength },
        bytes,
      });
    }
    await share(parts, forcedContextId);
  }, [share]);

  const copyItem = async (item: ItemRecord) => {
    try {
      if (item.content.kind === "attachment") {
        const bytes = await services.cloud.attachmentBytes(item.contextId, item.id, item.content);
        await services.copyFile({ name: item.content.name, contentType: item.content.contentType, bytes });
      } else await services.copyText(item.content.text);
      showToast("Copied to this device");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Copy failed"); }
  };
  const saveItem = async (item: ItemRecord) => {
    if (item.content.kind !== "attachment") return;
    try {
      const bytes = await services.cloud.attachmentBytes(item.contextId, item.id, item.content);
      if (await services.saveFile({ name: item.content.name, contentType: item.content.contentType, bytes })) showToast("File saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Save failed"); }
  };

  const submitRename = async () => {
    const title = renameText.trim().slice(0, 160);
    if (!selected || !title) return;
    try {
      if (selected.id === draftContext?.id) setDraftContext({ ...draftContext, title });
      else await services.cloud.renameContext(selected.id, title);
      setContexts((current) => current.map((context) => context.id === selected.id ? { ...context, title } : context));
      setRenaming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Rename failed"); }
  };

  const deleteContext = async (context: ContextRecord) => {
    if (!window.confirm(`Permanently delete “${context.title}” and all its items? There is no undo.`)) return;
    setMenuOpen(false);
    try {
      if (!navigation.localContexts.some(c => c.id === context.id)) await services.cloud.deleteContext(context.id);
      await services.outbox.removeContext?.(context.id);
      navigation.remove([context.id]);
      setContexts(current => current.filter(c => c.id !== context.id));
      setOptimisticItems(current => current.filter(item => item.contextId !== context.id));
      if (selectedId === context.id) setSelectedId(undefined);
      showToast("Context permanently deleted");
    } catch { setError("Deletion has not finished. Retry to complete cleanup."); }
  };

  const signOut = async () => {
    const [webPending, nativePending] = await Promise.all([services.outbox.count(), services.pendingNativeCount?.() ?? 0]);
    if (webPending + nativePending > 0 && !window.confirm(`${webPending + nativePending} pending share(s) will be removed. Sign out?`)) return;
    navigation.clear();
    await services.signOut();
    window.location.reload();
  };

  const syncLabel = queueCount > 0 || pendingWrites ? `Syncing ${Math.max(queueCount, 1)} item${Math.max(queueCount, 1) === 1 ? "" : "s"}`
    : fromCache ? "Offline history" : "Synced";

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Contexts sidebar">
        <div className="brand"><span className="brand-mark"><Icon>▦</Icon></span>Contexts</div>
        <button type="button" className="new-context" aria-label="New context" onClick={() => { setSelectedId(undefined); setError(undefined); }}><Icon>＋</Icon><span>New context</span></button>
        <label className="search"><Icon>⌕</Icon><input type="search" aria-label="Search contexts" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search contexts" /></label>
        <div className="sidebar-label">RECENT CONTEXTS</div>
        <nav className="context-list" aria-label="Your contexts">
          {visibleContexts.map((context) => <div className="context-row" key={context.id}><button type="button" key={context.id} aria-label={context.title === "New context" ? "Open new context draft" : context.title} aria-current={context.id === selectedId} onClick={() => setSelectedId(context.id)}><span>{context.title}</span>{context.unread ? <i aria-label="Unread" /> : null}</button><button type="button" className="context-delete" aria-label={`Delete context ${context.title}`} onClick={() => void deleteContext(context)}>×</button></div>)}
        </nav>
        <div className="sidebar-spacer" />
        <div className="device-state"><div><span className={`status-dot ${fromCache ? "offline" : ""}`} />{syncLabel}</div><div><Icon>▣</Icon>{services.device.name} · This device</div></div>
        <div className="account"><span className="avatar">{services.viewer.name.charAt(0).toLocaleUpperCase()}</span><span>{services.viewer.name}<small>Personal account</small></span><button type="button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Icon>⚙</Icon></button></div>
      </aside>

      <main className="main-panel">
        <header className="titlebar">
          <div className="title-group">
            {renaming ? <input className="rename-input" aria-label="Context name" value={renameText} autoFocus onChange={(event) => setRenameText(event.target.value)} onBlur={() => void submitRename()} onKeyDown={(event) => { if (event.key === "Enter") void submitRename(); }} />
              : <h1>{selected?.title ?? "New context"}</h1>}
            <small><Icon>▣</Icon>{visibleItems.length} {visibleItems.length === 1 ? "item" : "items"} · Only you</small>
          </div>
          <div className="header-actions"><span className={`sync ${fromCache ? "offline" : ""}`}><Icon>✓</Icon>{syncLabel}</span><button type="button" aria-label="Context options" aria-expanded={menuOpen} disabled={!selected} onClick={() => setMenuOpen((open) => !open)}><Icon>•••</Icon></button></div>
          {menuOpen && selected ? <div className="context-menu" role="menu">
            <button type="button" onClick={() => { setRenameText(selected.title); setRenaming(true); setMenuOpen(false); }}>Rename context</button>
            {!draftContext ? <button type="button" onClick={() => { void services.copyText(`${location.origin}/contexts/${selected.id}`).then(() => showToast("Context link copied")); setMenuOpen(false); }}>Copy link</button> : null}
            {!services.isDesktop && !draftContext ? <a href={`multi-device-context://context/${selected.id}`}>Open in desktop app</a> : null}
            <button type="button" className="danger" onClick={() => void deleteContext(selected)}>Delete context</button>
          </div> : null}
        </header>

        {error ? <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => { setError(undefined); void services.outbox.retry().then(services.drain).then(refreshQueue); }}>Retry</button><button type="button" aria-label="Dismiss error" onClick={() => setError(undefined)}>×</button></div> : null}
        <section className="timeline" aria-label="Shared items">
          {visibleItems.length ? <><div className="day-label">Today</div>{visibleItems.map((item) => <ItemCard key={item.id} item={item} cloud={services.cloud} onCopy={(value) => void copyItem(value)} onSave={(value) => void saveItem(value)} onDelete={(value) => void services.cloud.deleteItem(value.contextId, value.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Delete failed"))} />)}</>
            : <div className="empty"><Icon>▧</Icon><strong>A little space for your context.</strong><span>Paste text, a screenshot, or a file.</span></div>}
        </section>

        <div className="composer-wrap">
          <div className="composer">
            <textarea rows={2} value={text} aria-label="Paste to share instantly, or type a note" placeholder={codeMode ? "Paste code to share instantly…" : "Paste anything to share instantly…"}
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                if (services.readClipboard) {
                  event.preventDefault();
                  void services.readClipboard().then((snapshot) => {
                    if (snapshot.files.length) return shareFiles(snapshot.files);
                    if (snapshot.text?.length) return share([{ content: { kind: codeMode || snapshot.text.trimStart().startsWith("```") ? "code" : "text", text: snapshot.text } }]);
                    throw new Error("This clipboard format is not supported");
                  }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Clipboard sharing failed"));
                  return;
                }
                if (event.clipboardData.files.length) { event.preventDefault(); void shareFiles([...event.clipboardData.files]); return; }
                const pasted = event.clipboardData.getData("text/plain");
                if (pasted.length) { event.preventDefault(); void share([{ content: { kind: codeMode || pasted.trimStart().startsWith("```") ? "code" : "text", text: pasted } }]); }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && text.length) {
                  event.preventDefault(); const value = text; void share([{ content: { kind: codeMode ? "code" : "text", text: value } }], undefined, value);
                }
              }} />
            <div className="composer-tools"><div><button type="button" aria-label="Attach files" onClick={() => fileInput.current?.click()}><Icon>＋</Icon></button><button type="button" aria-label="Share as code" aria-pressed={codeMode} onClick={() => setCodeMode((active) => !active)}><Icon>&lt;/&gt;</Icon></button></div><span>Paste to share <kbd>{navigator.platform.includes("Mac") ? "⌘ V" : "Ctrl V"}</kbd></span></div>
          </div>
          <div className="composer-note">Pastes share immediately. For a typed note, press Enter.</div>
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) void shareFiles([...event.target.files]); event.target.value = ""; }} />
        </div>
        {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
      </main>

      {settingsOpen ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-head"><h2 id="settings-title">Settings</h2><button type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button></div>
        <div className="profile-row"><span className="avatar large">{services.viewer.name.charAt(0).toUpperCase()}</span><span><strong>{services.viewer.name}</strong><small>{services.viewer.email ?? services.viewer.uid}</small></span></div>
        <label className="setting-row"><span>Theme<small>Choose how Contexts looks.</small></span><select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label className="setting-row"><span>Launch at login<small>{services.setLaunchAtLogin ? "Start Contexts with this computer." : "Available in the desktop app."}</small></span><input type="checkbox" disabled={!services.setLaunchAtLogin || launchAtLogin === undefined} checked={launchAtLogin ?? false} onChange={(event) => { const enabled = event.target.checked; setLaunchAtLoginState(enabled); void services.setLaunchAtLogin?.(enabled).catch(() => setError("Could not change the startup setting")); }} /></label>
        <div className="privacy-note"><Icon>▣</Icon><span>Incoming items stay here until you explicitly choose Copy. Your contexts are visible only to you.</span></div>
        {services.agentKeys ? <AgentKeys client={services.agentKeys} /> : null}
        <button type="button" className="signout" onClick={() => void signOut()}>Sign out</button>
      </section></div> : null}
    </div>
  );
}

function browserDevice(): Device {
  const key = "mdc-browser-device-id";
  let id = localStorage.getItem(key);
  if (!id || !IdSchema.safeParse(id).success) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return { id: IdSchema.parse(id), name: "Browser" };
}

async function browserCopyFile(file: NativeFile): Promise<void> {
  if (!file.contentType.startsWith("image/") || file.contentType === "image/svg+xml" || !("ClipboardItem" in window)) {
    throw new Error("File copying is available in the desktop app. Use Save in this browser.");
  }
  const item = new ClipboardItem({ [file.contentType]: new Blob([bytesBuffer(file.bytes)], { type: file.contentType }) });
  await navigator.clipboard.write([item]);
}

async function browserSaveFile(file: NativeFile): Promise<boolean> {
  const url = URL.createObjectURL(new Blob([bytesBuffer(file.bytes)], { type: file.contentType }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

async function buildServices(session: ActiveSession): Promise<{ services: WorkspaceServices; dispose(): void }> {
  const device = session.bridge ? await session.bridge.getDevice() : browserDevice();
  const cloud = new FirebaseCloud(session.firebaseApp, session.uid, session.accessToken);
  const outbox = new DurableOutbox({ projectId: session.config.firebase.projectId, uid: session.uid });
  const runner = new OutboxRunner(outbox, cloud);
  const bridge = session.bridge;
  let lastNativeContext: Id | undefined;
  const storeNativeSnapshot = async (request: PendingClipboardShare) => {
    const parts: SharePart[] = request.snapshot.files.length
      ? request.snapshot.files.map((file) => ({ content: { kind: "attachment", name: file.name, contentType: file.contentType, size: file.bytes.byteLength }, bytes: file.bytes }))
      : request.snapshot.text?.length ? [{ content: { kind: "text", text: request.snapshot.text } }] : [];
    const drafts = parts.map((part, index): ShareDraft => ({
      contextId: request.id,
      itemId: newId(),
      title: deriveTitle(parts[0]!.content),
      content: part.content,
      device,
      createsContext: index === 0,
      nativeRequestId: request.id,
      ...(part.bytes ? { bytes: part.bytes } : {}),
    }));
    await outbox.enqueueNativeRequest(request.id, drafts);
    if (drafts.length) lastNativeContext = request.id;
  };
  const nativeStore: NativeQueueStore = {
    hasNativeRequest: (id) => outbox.hasNativeRequest(id),
    storeNativeSnapshot,
    markNativeAcknowledged: (id) => outbox.markNativeAcknowledged(id),
  };
  const drainNative = async (): Promise<Id | undefined> => {
    if (!bridge) return undefined;
    lastNativeContext = undefined;
    await drainNativeClipboardQueue(bridge, nativeStore);
    return lastNativeContext;
  };
  const initialNativeId = await drainNative();
  const initialNavigation = await bridge?.takeNavigation?.();
  void runner.drain();
  return {
    services: {
      ...(initialNavigation?.contextId || initialNativeId ? { initialContextId: initialNavigation?.contextId ?? initialNativeId! } : {}),
      agentKeys: cloud,
      isDesktop: Boolean(bridge),
      ...(bridge?.onNavigate ? { subscribeNavigation: (listener: (id?: Id) => void) => bridge.onNavigate!(event => listener(event.contextId)) } : {}),
      viewer: session.viewer,
      device,
      cloud,
      outbox,
      drain: () => runner.drain(),
      copyText: bridge ? (value) => bridge.copyText(value) : (value) => navigator.clipboard.writeText(value),
      copyFile: bridge ? (file) => bridge.copyFile(file) : browserCopyFile,
      saveFile: bridge ? (file) => bridge.saveFile(file) : browserSaveFile,
      signOut: bridge
        ? async () => {
            runner.stop();
            try { await session.signOut(); await outbox.clear(); }
            catch (error) { runner.resume(); void runner.drain(); throw error; }
          }
        : async () => {
            runner.stop();
            try { await outbox.clear(); await session.signOut(); }
            catch (error) { runner.resume(); void runner.drain(); throw error; }
          },
      ...(bridge ? {
        getLaunchAtLogin: () => bridge.getLaunchAtLogin(),
        setLaunchAtLogin: (enabled: boolean) => bridge.setLaunchAtLogin(enabled),
        pendingNativeCount: async () => (await bridge.getPendingClipboardShares()).length,
        readClipboard: () => bridge.readClipboard(),
        subscribeNativeShares: (listener: () => void) => bridge.onShareClipboard(listener),
        drainNativeShares: async () => {
          const contextId = await drainNative();
          window.setTimeout(() => void runner.drain(), 0);
          return contextId;
        },
      } : {}),
    },
    dispose: () => { runner.stop(); outbox.close(); },
  };
}

export default function App() {
  const manager = useMemo(() => new SessionManager(), []);
  const [session, setSession] = useState<ActiveSession>();
  const [workspace, setWorkspace] = useState<{ services: WorkspaceServices; dispose(): void }>();
  const [state, setState] = useState<"loading" | "login" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  const start = useCallback(async () => {
    setState("loading"); setError(undefined);
    try {
      await manager.prepare();
      const restored = await manager.restore();
      if (!restored) { setState("login"); return; }
      setSession(restored);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Contexts is unavailable"); setState("error"); }
  }, [manager]);
  useEffect(() => { void start(); }, [start]);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void buildServices(session).then((created) => {
      if (cancelled) created.dispose(); else { setWorkspace(created); setState("ready"); }
    }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Could not start synchronization"); setState("error"); });
    return () => { cancelled = true; };
  }, [session]);
  useEffect(() => () => workspace?.dispose(), [workspace]);

  if (state === "ready" && workspace) return <ContextWorkspace services={workspace.services} />;
  return <main className="gate"><div className="gate-card"><div className="brand gate-brand"><span className="brand-mark"><Icon>▦</Icon></span>Contexts</div>
    {state === "loading" ? <><div className="spinner" /><h1>Connecting your contexts</h1><p>Restoring your private, synchronized history.</p></> : null}
    {state === "login" ? <><h1>Move a thought between your computers.</h1><p>Sign in with your Google account. Everything stays private to you.</p><button type="button" className="login-button" onClick={() => void manager.login().then((active) => { if (active) setSession(active); }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Sign in failed"); setState("error"); })}>Continue with Google</button></> : null}
    {state === "error" ? <><h1>Contexts is unavailable</h1><p role="alert">{error}</p><button type="button" className="login-button" onClick={() => void start()}>Retry</button></> : null}
  </div></main>;
}
