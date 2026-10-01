import { prepareHistory } from "./history.js";
import { ContextOperations } from "./operations.js";
import { subscribeLocal } from "./local-db.js";
import { AttachmentPreview, fileParts, dayLabel } from "./media.js";
import type { ClipboardSnapshot, Content, Device, Id, NativeFile, PendingClipboardShare } from "@mdc/contracts";
import { ContentSchema, IdSchema, MAX_ATTACHMENT_BYTES } from "@mdc/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";

import { useNavigation } from "./navigation.js";
import { AgentKeys, type AgentKeyClient } from "./AgentKeys.js";

import { SessionManager, type ActiveSession } from "./auth.js";
import { FirebaseCloud, type CloudSnapshot } from "./cloud.js";
import { drainNativeClipboardQueue, type NativeQueueStore } from "./desktop.js";
import type { ContextRecord, ItemRecord, ShareDraft, Viewer } from "./model.js";
import { DurableOutbox, type QueuedShare } from "./outbox.js";
import { DeletionCleanup, ForegroundCatchup, ForegroundRefresh } from "./sync.js";
import "./theme.css";

type Unsubscribe = () => void;

export type WorkspaceCloud = {
  subscribeDeletedItems?(emit: (items: { contextId: Id; itemId: Id }[]) => void, fail: (error: Error) => void): Unsubscribe;
  subscribeDeletedContexts?(emit: (ids: Id[]) => void, fail: (error: Error) => void): Unsubscribe;
  subscribeContexts(emit: (snapshot: CloudSnapshot<ContextRecord>) => void, fail: (error: Error) => void): Unsubscribe;
  subscribeItems(contextId: Id, emit: (snapshot: CloudSnapshot<ItemRecord>) => void, fail: (error: Error) => void): Unsubscribe;
  refreshContexts?(): Promise<CloudSnapshot<ContextRecord>>;
  refreshDeletedContexts?(): Promise<Id[]>;
  refreshDeletedItems?(): Promise<{ contextId: Id; itemId: Id }[]>;
  refreshItems?(contextId: Id): Promise<CloudSnapshot<ItemRecord>>;
  setNetworkEnabled?(enabled: boolean): Promise<void>;
  renameContext(contextId: Id, title: string): Promise<void>;
  deleteContext(contextId: Id): Promise<void>;
  deleteItem(contextId: Id, itemId: Id): Promise<void>;
  attachmentBytes(contextId: Id, itemId: Id, content: Extract<Content, { kind: "attachment" }>): Promise<Uint8Array>;
};

export type WorkspaceOutbox = {
  readonly namespace: string;
  removeContext?(id: Id): Promise<void>;
  removeItem?(contextId: Id, itemId: Id): Promise<void>;
  cancelled?(): Promise<{ contexts: Id[]; items: Id[] }>;
  deletions?(): Promise<{ contextId: Id; itemId?: Id }[]>;
  enqueueBatch?(drafts: ShareDraft[]): Promise<void>;
  enqueue(draft: ShareDraft): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
  retry(key?: string): Promise<void>;
  list(): Promise<QueuedShare[]>;
};

export type WorkspaceServices = {
  remove?(contextId: Id, itemId?: Id): Promise<boolean>;
  initialContextId?: Id;
  agentKeys?: AgentKeyClient;
  settings?: { getSettings(): Promise<{ aiTitlesEnabled: boolean }>; setSettings(enabled: boolean): Promise<{ aiTitlesEnabled: boolean }> };
  isDesktop?: boolean;
  platformKind?: "browser" | "desktop" | "android";
  appOrigin?: string;
  activity?: { initialActive: boolean; subscribe(listener: (active: boolean) => void): Unsubscribe };
  subscribeNavigation?: (listener: (id?: Id) => void) => Unsubscribe;
  viewer: Viewer;
  device: Device;
  cloud: WorkspaceCloud;
  outbox: WorkspaceOutbox;
  drain(): Promise<void>;
  pause?(): void;
  resume?(): void;
  copyText(text: string): Promise<void>;
  copyFile(file: NativeFile): Promise<void>;
  saveFile(file: NativeFile): Promise<boolean>;
  shareFile?: (file: NativeFile) => Promise<boolean>;
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

export function sharePartsFromSnapshot(snapshot: ClipboardSnapshot): SharePart[] {
  return [
    ...(snapshot.text?.length ? [{ content: { kind: "text" as const, text: snapshot.text } }] : []),
    ...snapshot.files.map(file => ({ content: { kind: "attachment" as const, name: file.name, contentType: file.contentType, size: file.bytes.byteLength }, bytes: file.bytes })),
  ];
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

function ItemCard({
  item, cloud, onCopy, onSave, onShare, onDelete,
}: {
  item: ItemRecord;
  cloud: WorkspaceCloud;
  onCopy(item: ItemRecord): void;
  onSave(item: ItemRecord): void;
  onShare?(item: ItemRecord): void;
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
        {attachment && onShare ? <button type="button" onClick={() => onShare(item)} disabled={!item.ready}><Icon>↗</Icon>Share</button> : null}
        <button type="button" className="danger-quiet" aria-label={`Delete ${attachment?.name ?? "item"}`} onClick={() => onDelete(item)}><Icon>×</Icon></button>
      </div>
    </article>
  );
}

export function ContextWorkspace({ services }: { services: WorkspaceServices }) {
  const [contexts, setContexts] = useState<ContextRecord[]>([]);
  const confirmedKey = `mdc-confirmed:${services.outbox.namespace}`;
  const [confirmedContextIds, setConfirmedContextIds] = useState(() => readConfirmedContexts(confirmedKey));
  const confirmedContextIdsRef = useRef(confirmedContextIds);
  confirmedContextIdsRef.current = confirmedContextIds;
  const navigation = useNavigation(services.outbox.namespace, services.initialContextId);
  const { selectedId, select: setSelectedId, draftContext, text, codeMode } = navigation;
  const setText = (text: string) => navigation.patch({ text });
  const setCodeMode = (change: (value: boolean) => boolean) => navigation.patch({ code: change(codeMode) });
  const setDraftContext = (context?: ContextRecord) => navigation.patch(context ? { title: context.title } : { local: false });
  const [items, setItems] = useState<ItemRecord[]>([]);
  const [optimisticItems, setOptimisticItems] = useState<ItemRecord[]>([]);
  const [search, setSearch] = useState("");

  const [aiEnabled, setAiEnabled] = useState<boolean>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [renameTargetId, setRenameTargetId] = useState<Id>();
  const [queueCount, setQueueCount] = useState(0);
  const [syncStreams, setSyncStreams] = useState({
    contexts: { fromCache: false, pending: false },
    items: { fromCache: false, pending: false },
    deleted: { confirmed: !services.cloud.refreshDeletedContexts, failed: false },
    deletedItems: { confirmed: !services.cloud.refreshDeletedItems, failed: false },
  });
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("mdc-theme") as Theme | null) ?? "system");
  const [launchAtLogin, setLaunchAtLoginState] = useState<boolean>();
  const [refreshing, setRefreshing] = useState(false);
  const [active, setActive] = useState(() => services.activity?.initialActive ?? true);
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
  useEffect(() => { setMenuOpen(false); setRenaming(false); }, [selectedId]);
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
  useEffect(() => services.activity?.subscribe(setActive), [services.activity]);

  useEffect(() => {
    if (!services.settings) return;
    let active = true;
    const refresh = () => { void services.settings!.getSettings().then(value => { if (active) setAiEnabled(value.aiTitlesEnabled); }).catch(() => { if (active) setError("Could not load AI title settings"); }); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [services.settings, settingsOpen]);

  const seenContexts = useRef<Set<Id> | undefined>(undefined);
  const acknowledged = useRef(new Set<Id>());
  const deleted = useRef(new Set<Id>());
  const deletedItems = useRef(new Set<Id>());
  const knownDeletedItems = useRef(new Map<string, { contextId: Id; itemId: Id }>());
  const suppressCatchupAutoSelect = useRef(false);
  const backgroundInactive = useRef(false);
  const streamVersions = useRef({ contexts: 0, deleted: 0, deletedItems: 0, items: 0 });
  const deletionCleanup = useMemo(() => new DeletionCleanup(), [services.outbox]);
  const catchup = useRef(new ForegroundCatchup());
  const live = useRef({ services, active, mounted: true });
  live.current.services = services;
  live.current.active = active;
  const isLive = useCallback(() => live.current.mounted && live.current.services === services
    && (services.platformKind !== "android" || live.current.active), [services]);
  const refreshers = useRef({ contexts: new ForegroundRefresh(), deleted: new ForegroundRefresh(), deletedItems: new ForegroundRefresh(), items: new ForegroundRefresh() });
  const applyDeleted = useCallback(async (ids: Id[]) => {
    for (const id of ids) deleted.current.add(id);
    navigation.remove(ids);
    setContexts(current => current.filter(context => !deleted.current.has(context.id)));
    setOptimisticItems(current => current.filter(item => !deleted.current.has(item.contextId)));
    setConfirmedContextIds(current => {
      const retained = [...current].filter(id => !deleted.current.has(id));
      return retained.length === current.size ? current : new Set(retained);
    });
    for (const id of ids) localQueuedContexts.current.delete(id);
    if (deleted.current.has(navigation.selectedRef.current.id)) setSelectedId(undefined);
    // Retry known failed tombstones too, even if a subsequent snapshot omits them.
    const currentCleanup = deletionCleanup.reconcile(deleted.current,
      id => services.outbox.removeContext?.(id) ?? Promise.resolve());
    try {
      await currentCleanup;
      if (!isLive()) return;
      setSyncStreams(current => ({ ...current, deleted: { confirmed: true, failed: false } }));
    } catch (cause) {
      if (!isLive()) throw cause;
      setSyncStreams(current => ({ ...current, deleted: { confirmed: false, failed: true } }));
      setError("Could not remove local pending shares");
      throw cause;
    }
  }, [deletionCleanup, isLive, navigation.remove, services.outbox, setSelectedId]);
  const applyDeletedItems = useCallback(async (records: { contextId: Id; itemId: Id }[]) => {
    for (const item of records) {
      deletedItems.current.add(item.itemId);
      knownDeletedItems.current.set(`item:${item.contextId}:${item.itemId}`, item);
    }
    setItems(current => current.filter(item => !deletedItems.current.has(item.id)));
    setOptimisticItems(current => current.filter(item => !deletedItems.current.has(item.id)));
    try {
      await deletionCleanup.reconcile(knownDeletedItems.current.keys(), key => {
        const item = knownDeletedItems.current.get(key)!;
        return services.outbox.removeItem?.(item.contextId, item.itemId) ?? Promise.resolve();
      });
      if (isLive()) setSyncStreams(current => ({ ...current, deletedItems: { confirmed: true, failed: false } }));
    } catch (cause) {
      if (isLive()) {
        setSyncStreams(current => ({ ...current, deletedItems: { confirmed: false, failed: true } }));
        setError("Could not remove local pending items");
      }
      throw cause;
    }
  }, [deletionCleanup, isLive, services.outbox]);
  useEffect(() => {
    live.current.mounted = true;
    return () => {
      live.current.mounted = false;
      catchup.current.invalidate();
      for (const refresher of Object.values(refreshers.current)) refresher.invalidate();
    };
  }, [services]);
  useEffect(() => {
    if (services.platformKind === "android" && !active) return;
    return services.cloud.subscribeContexts((snapshot) => {
    streamVersions.current.contexts += 1;
    setConfirmedContextIds((current) => {
      const confirmed = snapshot.records.filter(context => (context.syncState === "synced" || context.syncState === "cached") && !current.has(context.id));
      return confirmed.length ? new Set([...current, ...confirmed.map(context => context.id)]) : current;
    });
    const currentId = navigation.selectedRef.current.id;
    for (const context of snapshot.records) localQueuedContexts.current.delete(context.id);
    setContexts(snapshot.records.filter(c => !deleted.current.has(c.id)).map(context => ({ ...context, unread: context.id !== currentId && context.updatedAt > (lastRead.current[context.id] ?? context.createdAt) })));
    setSyncStreams(current => ({ ...current, contexts: { fromCache: snapshot.fromCache, pending: snapshot.hasPendingWrites } }));
    if (!snapshot.fromCache) {
      const ready = snapshot.records.filter(c => c.syncState === "synced" && c.ready !== false);
      if (seenContexts.current && !suppressCatchupAutoSelect.current) {
        const incoming = ready.filter(c => !seenContexts.current!.has(c.id) && c.originDeviceId !== services.device.id && !localQueuedContexts.current.has(c.id))
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        if (incoming[0]) setSelectedId(incoming[0].id);
      } else seenContexts.current = new Set();
      for (const context of ready) seenContexts.current.add(context.id);
      for (const context of snapshot.records) acknowledged.current.add(context.id);
      if (acknowledged.current.has(currentId) && !snapshot.records.some(c => c.id === currentId) && !localQueuedContexts.current.has(currentId)) setSelectedId(undefined);
      else if (!navigation.selectedRef.current.drafts[currentId]?.local && !snapshot.records.some(c => c.id === currentId) && !localQueuedContexts.current.has(currentId)) setError("This context is unavailable or has been deleted");
    }
    }, cause => setError(cause.message || "Could not load contexts"));
  }, [active, services.cloud, services.device.id, services.platformKind, setSelectedId]);

  useEffect(() => {
    if (services.platformKind === "android" && !active) return;
    return services.cloud.subscribeDeletedContexts?.(ids => {
    streamVersions.current.deleted += 1;
    void applyDeleted(ids).catch(() => undefined);
    }, () => {
      setSyncStreams(current => ({ ...current, deleted: { confirmed: false, failed: true } }));
      setError("Could not synchronize deletions");
    });
  }, [active, applyDeleted, services.cloud, services.platformKind]);

  useEffect(() => {
    if (services.platformKind === "android" && !active) return;
    return services.cloud.subscribeDeletedItems?.(records => {
      streamVersions.current.deletedItems += 1;
      void applyDeletedItems(records).catch(() => undefined);
    }, () => {
      setSyncStreams(current => ({ ...current, deletedItems: { confirmed: false, failed: true } }));
      setError("Could not synchronize item deletions");
    });
  }, [active, applyDeletedItems, services.cloud, services.platformKind]);

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
    if (services.platformKind === "android" && !active) return;
    streamVersions.current.items += 1;
    return services.cloud.subscribeItems(selectedId, (snapshot) => {
      if (navigation.selectedRef.current.id !== selectedId) return;
      streamVersions.current.items += 1;
      setItems(snapshot.records.filter(item => !deletedItems.current.has(item.id)));
      setSyncStreams(current => ({ ...current, items: { fromCache: snapshot.fromCache, pending: snapshot.hasPendingWrites } }));
      const cloudIds = new Set(snapshot.records.map((item) => item.id));
      setOptimisticItems((current) => current.filter((item) => item.contextId !== selectedId || !cloudIds.has(item.id)));
    }, (cause) => setError(cause.message || "Could not load shared items"));
  }, [active, navigation.selectedRef, selectedContextConfirmed, selectedId, services.cloud, services.platformKind]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); setSettingsOpen(false); setRenaming(false); }
    };
    const back = () => { setMenuOpen(false); setSettingsOpen(false); setRenaming(false); };
    window.addEventListener("keydown", close);
    window.addEventListener("mdc:back", back);
    return () => { window.removeEventListener("keydown", close); window.removeEventListener("mdc:back", back); };
  }, []);

  const allContexts = [...navigation.localContexts, ...contexts.filter(context => !navigation.localContexts.some(draft => draft.id === context.id))];
  const selected = allContexts.find((context) => context.id === selectedId);
  const visibleContexts = allContexts.filter((context) => context.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const visibleItems = [...items.filter(item => item.contextId === selectedId), ...optimisticItems.filter((item) => item.contextId === selectedId)]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  const refresh = useCallback((): Promise<void> => {
    if (!isLive() || !services.cloud.refreshContexts || !services.cloud.refreshDeletedContexts) return Promise.resolve();
    const selectedAtStart = navigation.selectedRef.current.id;
    const scope = `${services.viewer.uid}:${selectedAtStart}`;
    return catchup.current.run(scope, async owns => {
      const current = () => owns() && isLive();
      if (!current()) return;
      for (const refresher of Object.values(refreshers.current)) refresher.invalidate();
      const versionsAtStart = { ...streamVersions.current };
      suppressCatchupAutoSelect.current = true;
      setRefreshing(true);
      const tasks: Promise<void>[] = [
        refreshers.current.contexts.run(`${services.viewer.uid}:contexts`, () => services.cloud.refreshContexts!(), snapshot => {
          if (!current() || streamVersions.current.contexts !== versionsAtStart.contexts) return;
          for (const context of snapshot.records) seenContexts.current?.add(context.id);
          setContexts(current => {
            const queued = current.filter(context => localQueuedContexts.current.has(context.id));
            const queuedIds = new Set(queued.map(context => context.id));
            return [...queued, ...snapshot.records.filter(context => !queuedIds.has(context.id) && !deleted.current.has(context.id))];
          });
          setConfirmedContextIds(current => {
            const incoming = snapshot.records.filter(context => !current.has(context.id));
            return incoming.length ? new Set([...current, ...incoming.map(context => context.id)]) : current;
          });
          setSyncStreams(current => ({ ...current, contexts: { fromCache: false, pending: snapshot.hasPendingWrites } }));
        }),
        refreshers.current.deleted.run(`${services.viewer.uid}:deleted`, () => services.cloud.refreshDeletedContexts!(), async ids => {
          if (!current()) return;
          if (streamVersions.current.deleted === versionsAtStart.deleted) return applyDeleted(ids);
        }),
        refreshers.current.deletedItems.run(`${services.viewer.uid}:deleted-items`, () => services.cloud.refreshDeletedItems?.() ?? Promise.resolve([]), async records => {
          if (!current()) return;
          if (streamVersions.current.deletedItems === versionsAtStart.deletedItems) return applyDeletedItems(records);
        }),
      ];
      if (selectedAtStart && confirmedContextIdsRef.current.has(selectedAtStart) && services.cloud.refreshItems) {
        tasks.push(refreshers.current.items.run(`${services.viewer.uid}:${selectedAtStart}`, () => services.cloud.refreshItems!(selectedAtStart), snapshot => {
          if (!current() || navigation.selectedRef.current.id !== selectedAtStart || streamVersions.current.items !== versionsAtStart.items) return;
          setItems(snapshot.records.filter(item => !deletedItems.current.has(item.id)));
          const ids = new Set(snapshot.records.map(item => item.id));
          setOptimisticItems(current => current.filter(item => item.contextId !== selectedAtStart || !ids.has(item.id)));
          setSyncStreams(current => ({ ...current, items: { fromCache: snapshot.fromCache, pending: snapshot.hasPendingWrites } }));
        }));
      }
      const results = await Promise.allSettled(tasks);
      if (!current()) return;
      const deletionReady = results[1]?.status === "fulfilled" && results[2]?.status === "fulfilled";
      if (!deletionReady) setSyncStreams(state => ({ ...state, deleted: { confirmed: false, failed: true } }));
      if (results[2]?.status !== "fulfilled") setSyncStreams(state => ({ ...state, deletedItems: { confirmed: false, failed: true } }));
      if (results.some(result => result.status === "rejected")) {
        setError(results.every(result => result.status === "rejected") ? "Could not refresh from the server" : "Some data could not be refreshed");
      }
      if (deletionReady) {
        await deletionCleanup.finish(current, () => {
          setSyncStreams(state => ({ ...state, deleted: { confirmed: true, failed: false }, deletedItems: { confirmed: true, failed: false } }));
          if (services.platformKind === "android") services.resume?.();
        });
      }
    }, cause => {
      if (!isLive()) return;
      if (cause) {
        setSyncStreams(state => ({ ...state, deleted: { confirmed: false, failed: true } }));
        setError(cause instanceof Error ? cause.message : "Could not refresh from the server");
      }
      setRefreshing(false);
      suppressCatchupAutoSelect.current = backgroundInactive.current;
    });
  }, [applyDeleted, applyDeletedItems, deletionCleanup, isLive, navigation.selectedRef, services]);

  useEffect(() => {
    if (services.platformKind !== "android") return;
    let current = true;
    if (!active) {
      backgroundInactive.current = true;
      suppressCatchupAutoSelect.current = true;
      catchup.current.invalidate();
      for (const refresher of Object.values(refreshers.current)) refresher.invalidate();
      setRefreshing(false);
      services.pause?.();
      void services.cloud.setNetworkEnabled?.(false);
      return () => { current = false; };
    }
    backgroundInactive.current = false;
    void Promise.resolve(services.cloud.setNetworkEnabled?.(true)).then(async () => {
      if (!current) return;
      await refresh();
    }).catch(() => {
      if (current) setError("Could not restore network access");
    });
    return () => { current = false; };
  }, [active, refresh, services]);
  useEffect(() => {
    if (!active) return;
    const online = () => void refresh();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [active, refresh]);

  const restoreQueued = useCallback(async (selectContext?: Id, selectLatestNative = false) => {
    const queued = (await services.outbox.list()).filter(record => !deleted.current.has(record.contextId));
    if (selectLatestNative) {
      selectContext = queued.filter((record) => record.nativeRequestId)
        .sort((left, right) => right.queuedAt - left.queuedAt)[0]?.contextId;
    }
    if (selectContext) setSelectedId(selectContext);
    if (queued.length === 0) { setOptimisticItems([]); return; }
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

  const pendingDeletionCount = useRef(0);
  const queueRefreshRevision = useRef(0);
  const refreshQueue = useCallback(async () => {
    const revision = ++queueRefreshRevision.current;
    const queued = await services.outbox.list();
    const deletions = await services.outbox.deletions?.() ?? [];
    if (revision !== queueRefreshRevision.current) return;
    if (deletions.length) setError("Deletion is not confirmed yet. Retry or reconnect to finish.");
    else if (pendingDeletionCount.current) setError(current => current?.startsWith("Deletion is not confirmed") ? undefined : current);
    pendingDeletionCount.current = deletions.length;
    const cancelled = await services.outbox.cancelled?.();
    if (revision !== queueRefreshRevision.current) return;
    if (cancelled) {
      for (const id of cancelled.contexts) deleted.current.add(id);
      for (const id of cancelled.items) deletedItems.current.add(id);
      setContexts(current => current.filter(c => !deleted.current.has(c.id)));
      setItems(current => current.filter(item => !deletedItems.current.has(item.id) && !deleted.current.has(item.contextId)));
      setOptimisticItems(current => current.filter(item => !deletedItems.current.has(item.id) && !deleted.current.has(item.contextId)));
    }
    setQueueCount(queued.length + deletions.length);
    const failed = queued.find((record) => record.status === "paused" || record.status === "failed");
    if (failed?.lastError) setError(failed.lastError);
  }, [services.outbox]);
  useEffect(() => { void refreshQueue(); return subscribeLocal(() => { void refreshQueue(); }); }, [refreshQueue]);
  useEffect(() => {
    if (queueCount === 0 || (services.platformKind === "android" && !active)) return;
    const timer = window.setInterval(() => void refreshQueue(), 2_000);
    return () => window.clearInterval(timer);
  }, [active, queueCount, refreshQueue, services.platformKind]);
  useEffect(() => {
    let active = true;
    void restoreQueued().catch(() => { if (active) setError("Pending shares could not be restored"); });
    return () => { active = false; };
  }, [restoreQueued]);
  useEffect(() => {
    if (!services.subscribeNativeShares || !services.drainNativeShares || (services.platformKind === "android" && !active)) return;
    return services.subscribeNativeShares(() => {
      void services.drainNativeShares!()
        .then((contextId) => restoreQueued(contextId))
        .then(refreshQueue)
        .catch((cause: unknown) => {
          void restoreQueued(undefined, true).then(refreshQueue).then(services.drain);
          setError(cause instanceof Error ? cause.message : "Clipboard sharing failed");
        });
    });
  }, [active, refreshQueue, restoreQueued, services]);

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
      if (services.outbox.enqueueBatch) await services.outbox.enqueueBatch(drafts);
      else for (const draft of drafts) await services.outbox.enqueue(draft);
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
    try { await share(await fileParts(files), forcedContextId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Files could not be shared"); }
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
  const shareItem = async (item: ItemRecord) => {
    if (item.content.kind !== "attachment" || !services.shareFile) return;
    try {
      const bytes = await services.cloud.attachmentBytes(item.contextId, item.id, item.content);
      if (await services.shareFile({ name: item.content.name, contentType: item.content.contentType, bytes })) showToast("Share sheet opened");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Share failed"); }
  };

  const submitRename = async () => {
    const title = renameText.trim().slice(0, 160);
    if (!selected || selected.id !== renameTargetId || !title) return;
    try {
      if (selected.id === draftContext?.id) setDraftContext({ ...draftContext, title });
      else await services.cloud.renameContext(selected.id, title);
      setContexts((current) => current.map((context) => context.id === selected.id ? { ...context, title } : context));
      setRenaming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Rename failed"); }
  };

  const fallbackDeletes = useRef(new Map<string, () => Promise<void>>());
  const remove = async (contextId: Id, itemId?: Id): Promise<boolean> => {
    if (services.remove) return services.remove(contextId, itemId);
    const key = `${contextId}:${itemId ?? "context"}`;
    const action = async () => {
      if (itemId) { await services.outbox.removeItem?.(contextId, itemId); await services.cloud.deleteItem(contextId, itemId); }
      else { await services.outbox.removeContext?.(contextId); await services.cloud.deleteContext(contextId); }
      fallbackDeletes.current.delete(key);
    };
    fallbackDeletes.current.set(key, action); await action(); return true;
  };
  const deleteContext = async (context: ContextRecord) => {
    if (!window.confirm(`Permanently delete “${context.title}” and all its items? There is no undo.`)) return;
    setMenuOpen(false);
    try {
      const complete = await remove(context.id);
      deleted.current.add(context.id); navigation.remove([context.id]);
      setContexts(current => current.filter(c => c.id !== context.id));
      setOptimisticItems(current => current.filter(item => item.contextId !== context.id));
      if (selectedId === context.id) setSelectedId(undefined);
      if (complete) showToast("Context permanently deleted"); else setError("Deletion is not confirmed yet. Retry or reconnect to finish.");
      await refreshQueue();
    } catch { setError("Deletion is not confirmed yet. Retry or reconnect to finish."); }
  };
  const deleteItem = async (item: ItemRecord) => {
    try {
      const complete = await remove(item.contextId, item.id);
      deletedItems.current.add(item.id);
      setItems(current => current.filter(i => i.id !== item.id));
      setOptimisticItems(current => current.filter(i => i.id !== item.id));
      if (!confirmedContextIds.has(item.contextId) && !(await services.outbox.list()).some(record => record.contextId === item.contextId)) {
        localQueuedContexts.current.delete(item.contextId);
        setContexts(current => current.filter(context => context.id !== item.contextId));
        if (navigation.selectedRef.current.id === item.contextId) setSelectedId(undefined);
      }
      if (!complete) setError("Deletion is not confirmed yet. Retry or reconnect to finish.");
      await refreshQueue();
    } catch { setError("Deletion is not confirmed yet. Retry or reconnect to finish."); }
  };
  const retry = async () => {
    setError(undefined); navigation.retry();
    try { for (const action of fallbackDeletes.current.values()) await action(); await services.outbox.retry(); await services.drain(); await refreshQueue(); }
    catch { setError("Operation is not confirmed yet. Reconnect and retry."); }
  };

  const signOut = async () => {
    const [webPending, nativePending] = await Promise.all([services.outbox.count(), services.pendingNativeCount?.() ?? 0]);
    if (webPending + nativePending > 0 && !window.confirm(`${webPending + nativePending} pending share(s) will be removed. Sign out?`)) return;
    await navigation.clear();
    await services.signOut();
    window.location.reload();
  };

  const pendingWrites = syncStreams.contexts.pending || syncStreams.items.pending;
  const fromCache = syncStreams.contexts.fromCache || syncStreams.items.fromCache;
  const syncLabel = queueCount > 0 || pendingWrites ? `Syncing ${Math.max(queueCount, 1)} item${Math.max(queueCount, 1) === 1 ? "" : "s"}`
    : fromCache ? "Offline history" : syncStreams.deleted.failed || !syncStreams.deleted.confirmed || syncStreams.deletedItems.failed || !syncStreams.deletedItems.confirmed ? "Sync incomplete" : "Synced";

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
        <div className="account"><span className="avatar">{services.viewer.name.charAt(0).toLocaleUpperCase()}</span><span>{services.viewer.name}<small>Personal account</small></span>{services.platformKind !== "android" ? <button type="button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Icon>⚙</Icon></button> : null}</div>
      </aside>

      <main className="main-panel">
        <header className="titlebar">
          <div className="title-group">
            {renaming ? <input className="rename-input" aria-label="Context name" value={renameText} autoFocus onChange={(event) => setRenameText(event.target.value)} onBlur={() => void submitRename()} onKeyDown={(event) => { if (event.key === "Enter") void submitRename(); }} />
              : <h1>{selected?.title ?? "New context"}</h1>}
            <small><Icon>▣</Icon>{visibleItems.length} {visibleItems.length === 1 ? "item" : "items"} · Your account</small>
          </div>
          <div className="header-actions"><button type="button" className="refresh" aria-label="Refresh" disabled={refreshing} onClick={() => void refresh()}><Icon>↻</Icon><span>{refreshing ? "Refreshing" : "Refresh"}</span></button><span className={`sync ${fromCache ? "offline" : ""}`}><Icon>✓</Icon>{syncLabel}</span>{services.platformKind === "android" ? <button type="button" className="mobile-settings" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Icon>⚙</Icon></button> : null}<button type="button" aria-label="Context options" aria-expanded={menuOpen} disabled={!selected} onClick={() => setMenuOpen((open) => !open)}><Icon>•••</Icon></button></div>
          {menuOpen && selected ? <div className="context-menu" role="menu">
            <button type="button" onClick={() => { setRenameTargetId(selected.id); setRenameText(selected.title); setRenaming(true); setMenuOpen(false); }}>Rename context</button>
            {!draftContext ? <button type="button" onClick={() => { void services.copyText(`${services.appOrigin ?? location.origin}/contexts/${selected.id}`).then(() => showToast("Context link copied")); setMenuOpen(false); }}>Copy link</button> : null}
            {!services.isDesktop && services.platformKind !== "android" && !draftContext ? <a href={`multi-device-context://context/${selected.id}`}>Open in app</a> : null}
            <button type="button" className="danger" onClick={() => void deleteContext(selected)}>Delete context</button>
          </div> : null}
        </header>

        {error || navigation.issue ? <div className="error-banner" role="alert"><span>{error ?? navigation.issue}</span><button type="button" onClick={() => void retry()}>Retry</button><button type="button" aria-label="Dismiss error" onClick={() => setError(undefined)}>×</button></div> : null}
        <section className="timeline" aria-label="Shared items">
          {visibleItems.length ? <>{visibleItems.map((item, index) => <Fragment key={item.id}>{index === 0 || dayLabel(visibleItems[index - 1]!.createdAt) !== dayLabel(item.createdAt) ? <div className="day-label">{dayLabel(item.createdAt)}</div> : null}<ItemCard item={item} cloud={services.cloud} onCopy={(value) => void copyItem(value)} onSave={(value) => void saveItem(value)} {...(services.shareFile ? { onShare: (value: ItemRecord) => void shareItem(value) } : {})} onDelete={(value) => void deleteItem(value)} /></Fragment>)}</>
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
                if (services.platformKind !== "android" && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && text.length) {
                  event.preventDefault(); const value = text; void share([{ content: { kind: codeMode ? "code" : "text", text: value } }], undefined, value);
                }
              }} />
            <div className="composer-tools"><div><button type="button" aria-label="Attach files" onClick={() => fileInput.current?.click()}><Icon>＋</Icon></button><button type="button" aria-label="Share as code" aria-pressed={codeMode} onClick={() => setCodeMode((active) => !active)}><Icon>&lt;/&gt;</Icon></button></div>{services.platformKind === "android" ? <div className="mobile-compose-actions"><button type="button" aria-label="Paste" onClick={() => { void services.readClipboard?.().then(snapshot => share(sharePartsFromSnapshot(snapshot).map(part => part.content.kind === "text" && codeMode ? { ...part, content: { kind: "code", text: part.content.text } } : part))).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Clipboard sharing failed")); }}>Paste</button><button type="button" className="send" aria-label="Send" disabled={!text.length} onClick={() => { const value = text; void share([{ content: { kind: codeMode ? "code" : "text", text: value } }], undefined, value); }}>Send</button></div> : <span>Paste to share <kbd>{navigator.platform.includes("Mac") ? "⌘ V" : "Ctrl V"}</kbd></span>}</div>
          </div>
          <div className="composer-note">{services.platformKind === "android" ? "Pastes share immediately. For a typed note, tap Send." : "Pastes share immediately. For a typed note, press Enter."}<br />{aiEnabled ? "AI titles send the first text (up to 8,000 characters), or filename and type, to OpenRouter. File contents are not sent. Disable in Settings." : aiEnabled === false ? "AI titles are off. Titles are derived without an external model." : "AI title settings are loading. OpenRouter may receive the first text or filename; never file bytes."}</div>
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) void shareFiles([...event.target.files]); event.target.value = ""; }} />
        </div>
        {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
      </main>

      {settingsOpen ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-head"><h2 id="settings-title">Settings</h2><button type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button></div>
        <div className="profile-row"><span className="avatar large">{services.viewer.name.charAt(0).toUpperCase()}</span><span><strong>{services.viewer.name}</strong><small>{services.viewer.email ?? services.viewer.uid}</small></span></div>
        <label className="setting-row"><span>Theme<small>Choose how Contexts looks.</small></span><select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        {services.platformKind !== "android" ? <label className="setting-row"><span>Launch at login<small>{services.setLaunchAtLogin ? "Start Contexts with this computer." : "Available in the desktop app."}</small></span><input type="checkbox" disabled={!services.setLaunchAtLogin || launchAtLogin === undefined} checked={launchAtLogin ?? false} onChange={(event) => { const enabled = event.target.checked; setLaunchAtLoginState(enabled); void services.setLaunchAtLogin?.(enabled).catch(() => setError("Could not change the startup setting")); }} /></label> : null}
        {services.settings ? <label className="setting-row"><span>AI context titles<small>Send first text or filename/type to OpenRouter. Turning off prevents new requests; already sent requests cannot be recalled.</small></span><input aria-label="AI context titles" type="checkbox" disabled={aiEnabled === undefined} checked={aiEnabled ?? false} onChange={event => { const enabled = event.target.checked; setAiEnabled(undefined); void services.settings!.setSettings(enabled).then(value => setAiEnabled(value.aiTitlesEnabled)).catch(() => setError("Could not save AI setting. Reopen Settings to retry.")); }} /></label> : null}
        <div className="privacy-note"><Icon>▣</Icon><span>Incoming items stay here until you explicitly choose Copy. Other accounts cannot access your contexts. Service operators process data; this is not end-to-end encryption.</span></div>
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
  const native = session.platform.native;
  const device = native ? await native.getDevice() : browserDevice();
  await prepareHistory(session.firebaseApp);
  const cloud = new FirebaseCloud(session.firebaseApp, session.uid, session.accessToken);
  const outbox = new DurableOutbox({ projectId: session.config.firebase.projectId, uid: session.uid });
  const operations = new ContextOperations(outbox, cloud);
  const runner = operations.runner;
  let lastNativeContext: Id | undefined;
  const storeNativeSnapshot = async (request: PendingClipboardShare) => {
    const parts = sharePartsFromSnapshot(request.snapshot);
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
    if (!native) return undefined;
    lastNativeContext = undefined;
    await drainNativeClipboardQueue(native, nativeStore);
    return lastNativeContext;
  };
  const initialNativeId = await drainNative();
  const initialNavigation = await native?.takeNavigation?.();
  if (initialNavigation && !initialNavigation.contextId && !initialNativeId) window.history.replaceState({}, "", "/");
  // Android starts paused until its guarded foreground reads and durable cleanup
  // complete. Desktop/browser retain their existing startup publishing behavior.
  if (session.platform.kind === "android") runner.stop();
  else void runner.drain().catch(() => {});
  return {
    services: {
      ...(initialNavigation?.contextId || initialNativeId ? { initialContextId: initialNavigation?.contextId ?? initialNativeId! } : {}),
      agentKeys: cloud,
      settings: cloud,
      remove: (contextId, itemId) => operations.remove(contextId, itemId),
      isDesktop: session.platform.kind === "desktop",
      platformKind: session.platform.kind,
      appOrigin: session.config.appOrigin,
      ...(session.platform.activity ? { activity: session.platform.activity } : {}),
      ...(native?.onNavigate ? { subscribeNavigation: (listener: (id?: Id) => void) => {
        let active = true;
        const unsubscribe = native.onNavigate!(event => listener(event.contextId));
        void native.takeNavigation?.().then(event => { if (active && event) listener(event.contextId); }).catch(() => {});
        return () => { active = false; unsubscribe(); };
      } } : {}),
      viewer: session.viewer,
      device,
      cloud,
      outbox,
      drain: () => runner.drain(),
      pause: () => runner.stop(),
      resume: () => runner.resume(),
      copyText: native ? (value) => native.copyText(value) : (value) => navigator.clipboard.writeText(value),
      copyFile: native ? (file) => native.copyFile(file) : browserCopyFile,
      saveFile: native ? (file) => native.saveFile(file) : browserSaveFile,
      ...(session.platform.shareFile ? { shareFile: session.platform.shareFile } : {}),
      signOut: native
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
      ...(native ? {
        ...(native.getLaunchAtLogin ? { getLaunchAtLogin: () => native.getLaunchAtLogin!() } : {}),
        ...(native.setLaunchAtLogin ? { setLaunchAtLogin: (enabled: boolean) => native.setLaunchAtLogin!(enabled) } : {}),
        pendingNativeCount: async () => (await native.getPendingClipboardShares()).length,
        readClipboard: () => native.readClipboard(),
        subscribeNativeShares: (listener: () => void) => native.onShareClipboard(listener),
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
    {state === "login" ? <><h1>Move a thought between your computers.</h1><p>Sign in with your Google account. Your contexts are isolated from other accounts. AI titles are optional; service operators process stored data.</p><button type="button" className="login-button" onClick={() => void manager.login().then((active) => { if (active) setSession(active); }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Sign in failed"); setState("error"); })}>Continue with Google</button></> : null}
    {state === "error" ? <><h1>Contexts is unavailable</h1><p role="alert">{error}</p><button type="button" className="login-button" onClick={() => void start()}>Retry</button></> : null}
  </div></main>;
}
