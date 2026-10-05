import { SidebarResize } from "./sidebar-resize.js";
import { AccessPage } from "./AccessPage.js";
import { isAccessPageRequest } from "./browser-identity.js";
import { applyLocalAccess, readLocalAccess } from "./local-access.js";
import { createAccountSignOut, type AccountSignOut, type SignOutSummary } from "./account-signout.js";
import { prepareHistory } from "./history.js";
import { ContextOperations } from "./operations.js";
import { subscribeLocal } from "./local-db.js";
import { AttachmentPreview, fileParts, dayLabel } from "./media.js";
import type { ClipboardSnapshot, Content, Device, Id, NativeFile, PendingClipboardShare } from "@mdc/contracts";
import { ContentSchema, IdSchema, MAX_ATTACHMENT_BYTES } from "@mdc/contracts";
import { useSyncExternalStore, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment, type ReactNode, type ClipboardEvent } from "react";

import { useNavigation } from "./navigation.js";

import { SessionManager, type ActiveSession, type SessionProfile } from "./auth.js";
import { FirebaseCloud, type CloudSnapshot } from "./cloud.js";
import { drainNativeClipboardQueue, type NativeQueueStore } from "./desktop.js";
import type { ContextRecord, ItemRecord, ShareDraft, Viewer } from "./model.js";
import { DurableOutbox, type QueuedShare } from "./outbox.js";
import { DeletionCleanup, ForegroundCatchup, ForegroundRefresh } from "./sync.js";
import { ChatSidebar, ChatTopbar, ChatMessage, ChatComposer, WorkspaceIcon, displayTitle, formatFileSize } from "./workspace-view.js";
import { ChatContextMenu, type ChatMenuAnchor } from "./chat-context-menu.js";
import { WorkspaceDialog, trapFocus } from "./workspace-overlay.js";
import { useTimelineScroll } from "./use-timeline-scroll.js";
import { frozenClipboardParts, insertClipboardText, keyboardSends, type SharePart } from "./workspace-input.js";
import "./theme.css";

type Unsubscribe = () => void;
const emptySubscribe = () => () => {};

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
  settings?: { getSettings(): Promise<{ aiTitlesEnabled: boolean }>; setSettings(enabled: boolean): Promise<{ aiTitlesEnabled: boolean }> };
  isDesktop?: boolean;
  platformKind?: "browser" | "desktop" | "android";
  appOrigin?: string;
  accessMode?: "own" | "all";
  accessActive?(): boolean;
  checkAccess?(): Promise<void>;
  openAccessPanel?(): Promise<void>;
  activity?: { initialActive: boolean; subscribe(listener: (active: boolean) => void): Unsubscribe };
  subscribeNavigation?: (listener: (id?: Id) => void) => Unsubscribe;
  viewer: Viewer;
  profile?: SessionProfile;
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
  accountSignOut?: AccountSignOut;
  signOut(): Promise<void>;
  getLaunchAtLogin?: () => Promise<boolean>;
  setLaunchAtLogin?: (enabled: boolean) => Promise<void>;
  pendingNativeCount?: () => Promise<number>;
  readClipboard?: () => Promise<ClipboardSnapshot>;
  subscribeNativeShares?: (listener: () => void) => Unsubscribe;
  drainNativeShares?: () => Promise<Id | undefined>;
};

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

type ClipboardConfirmation = { id: string; target: Id; title: string; parts: SharePart[]; owner: WorkspaceServices };
type WorkspacePanel =
  | { kind: "context"; context: ContextRecord }
  | { kind: "rename"; context: ContextRecord }
  | { kind: "delete-context"; context: ContextRecord }
  | { kind: "item"; item: ItemRecord }
  | { kind: "delete-item"; item: ItemRecord }
  | { kind: "clipboard"; snapshot: ClipboardConfirmation }
  | { kind: "add"; contextId: Id; title: string }
  | { kind: "settings" | "signout" };

export function ContextWorkspace({ services }: { services: WorkspaceServices }) {
  const viewer = useSyncExternalStore(services.profile?.subscribe ?? emptySubscribe, services.profile?.getSnapshot ?? (() => services.viewer));
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
  const [panel, setPanel] = useState<WorkspacePanel>();
  const [chatMenu, setChatMenu] = useState<{ context: ContextRecord; anchor: ChatMenuAnchor; opener: HTMLElement; owner: WorkspaceServices }>();
  const settingsOpen = panel?.kind === "settings";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia?.("(max-width: 839px)").matches ?? false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [accountBlocked, setAccountBlocked] = useState(false);
  const [signOutSummary, setSignOutSummary] = useState<SignOutSummary>();
  const signOutFlow = useMemo(() => services.accountSignOut ?? createAccountSignOut({
    namespace: services.outbox.namespace,
    pause: () => { services.pause?.(); return () => services.resume?.(); },
    settle: async () => {},
    signOut: async cleanup => { await services.signOut(); await cleanup(); },
  }), [services]);
  const backgroundRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelOpener = useRef<HTMLElement | null>(null);
  const panelRef = useRef(panel); panelRef.current = panel;
  const pendingPublishes = useRef(new Set<Promise<unknown>>());
  const clipboardBusy = useRef(false);
  const sendsInFlight = useRef(new Set<string>());
  const [, setSendTick] = useState(0);
  const binarySent = useRef(new Set<string>());
  const fileTarget = useRef<{ id: Id; owner: WorkspaceServices } | undefined>(undefined);
  const pickerWakeups = useRef(new Set<(cancelled?: boolean) => void>());
  const [renameText, setRenameText] = useState("");
  const [queueCount, setQueueCount] = useState(0);
  const [syncStreams, setSyncStreams] = useState({
    contexts: { fromCache: false, pending: false, failed: false },
    items: { fromCache: false, pending: false, failed: false },
    deleted: { confirmed: !services.cloud.refreshDeletedContexts, failed: false },
    deletedItems: { confirmed: !services.cloud.refreshDeletedItems, failed: false },
  });
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("mdc-theme") as Theme | null) ?? "system");
  const [launchAtLogin, setLaunchAtLoginState] = useState<boolean>();
  const [refreshing, setRefreshing] = useState(false);
  const refreshError = useRef<string | undefined>(undefined);
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
  const signingOut = useRef(false);
  const nativeReconcile = useRef<(() => void) | undefined>(undefined);
  const itemStatusScope = useRef<Id | undefined>(undefined);
  const live = useRef({ services, active, mounted: true });
  live.current.services = services;
  live.current.active = active;
  const isLive = useCallback(() => (services.accessActive?.() ?? true) && !signingOut.current && live.current.mounted && live.current.services === services
    && (services.platformKind !== "android" || live.current.active), [services]);
  const restorePanelFocus = useCallback(() => {
    window.setTimeout(() => {
      const opener = panelOpener.current;
      if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
      else {
        const row = sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
        (row && !row.closest("[inert]") ? row : menuRef.current)?.focus({ preventScroll: true });
      }
    }, 0);
  }, []);
  const closePanel = useCallback((force = false) => {
    if (!force && (dialogBusy || accountBlocked)) return;
    setPanel(undefined); setDialogError(undefined); restorePanelFocus();
  }, [accountBlocked, dialogBusy, restorePanelFocus]);
  const openPanel = (next: WorkspacePanel) => {
    if (accountBlocked) return;
    if (!panelRef.current) panelOpener.current = document.activeElement as HTMLElement;
    setDialogError(undefined); setPanel(next);
  };
  const closeDrawer = useCallback((restore = true) => {
    setDrawerOpen(false);
    if (restore) window.setTimeout(() => menuRef.current?.focus({ preventScroll: true }), 0);
  }, []);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 839px)");
    if (!query) return;
    let lastFocus: HTMLElement | null = null;
    const focused = (event: FocusEvent) => { if (event.target instanceof HTMLElement) lastFocus = event.target; };
    const changed = () => {
      setCompact(query.matches);
      if (!query.matches) {
        setDrawerOpen(false);
        if (lastFocus?.classList.contains("drawer-close")) window.setTimeout(() => (sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? sidebarRef.current?.querySelector<HTMLElement>(".new-context"))?.focus({ preventScroll: true }), 0);
        else if (lastFocus?.classList.contains("menu-button")) window.setTimeout(() => mainRef.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true }), 0);
      } else if (lastFocus && sidebarRef.current?.contains(lastFocus)) window.setTimeout(() => menuRef.current?.focus({ preventScroll: true }), 0);
    };
    query.addEventListener("change", changed); window.addEventListener("focusin", focused);
    return () => { query.removeEventListener("change", changed); window.removeEventListener("focusin", focused); };
  }, []);
  useLayoutEffect(() => {
    if (sidebarRef.current) sidebarRef.current.inert = compact && !drawerOpen;
    if (mainRef.current) mainRef.current.inert = compact && drawerOpen;
    if (compact && drawerOpen && !panel) sidebarRef.current?.querySelector<HTMLElement>(".drawer-close")?.focus({ preventScroll: true });
  }, [compact, drawerOpen, panel]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panel) { event.preventDefault(); closePanel(); }
        else if (drawerOpen) { event.preventDefault(); closeDrawer(); }
      } else if (!panel && compact && drawerOpen && sidebarRef.current) trapFocus(event, sidebarRef.current);
    };
    const back = (event: Event) => {
      if (panel) { event.preventDefault(); closePanel(); }
      else if (drawerOpen) { event.preventDefault(); closeDrawer(); }
    };
    window.addEventListener("keydown", key); window.addEventListener("mdc:back", back);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("mdc:back", back); };
  }, [panel, compact, drawerOpen, closePanel, closeDrawer]);
  useEffect(() => { setChatMenu(undefined); setPanel(undefined); setDrawerOpen(false); clipboardBusy.current = false; signingOut.current = false; setAccountBlocked(false); setSignOutSummary(undefined); sendsInFlight.current.clear(); }, [services]);

  const refreshers = useRef({ contexts: new ForegroundRefresh(), deleted: new ForegroundRefresh(), deletedItems: new ForegroundRefresh(), items: new ForegroundRefresh() });
  const applyDeleted = useCallback(async (ids: Id[]) => {
    if (!isLive()) return;
    for (const id of ids) deleted.current.add(id);
    if (panelRef.current?.kind === "clipboard" && deleted.current.has(panelRef.current.snapshot.target)) {
      closePanel(true); showToast("The target chat was deleted. Pasted files were not sent.");
    }
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
    if (!isLive()) return;
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
    setRefreshing(false);
    return () => {
      live.current.mounted = false;
      catchup.current.invalidate();
      for (const refresher of Object.values(refreshers.current)) refresher.invalidate();
    };
  }, [services]);
  useEffect(() => {
    if (services.platformKind === "android" && !active) return;
    return services.cloud.subscribeContexts((snapshot) => {
    if (!isLive()) return;
    streamVersions.current.contexts += 1;
    setConfirmedContextIds((current) => {
      const confirmed = snapshot.records.filter(context => (context.syncState === "synced" || context.syncState === "cached") && !current.has(context.id));
      return confirmed.length ? new Set([...current, ...confirmed.map(context => context.id)]) : current;
    });
    const currentId = navigation.selectedRef.current.id;
    for (const context of snapshot.records) localQueuedContexts.current.delete(context.id);
    setContexts(snapshot.records.filter(c => !deleted.current.has(c.id)).map(context => ({ ...context, unread: context.id !== currentId && context.updatedAt > (lastRead.current[context.id] ?? context.createdAt) })));
    setSyncStreams(current => ({ ...current, contexts: { fromCache: snapshot.fromCache, pending: snapshot.hasPendingWrites, failed: snapshot.fromCache && current.contexts.failed } }));
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
    }, cause => {
      if (!isLive()) return;
      streamVersions.current.contexts += 1;
      setSyncStreams(current => ({ ...current, contexts: { ...current.contexts, failed: true } }));
      setError(cause.message || "Could not load contexts");
    });
  }, [active, isLive, services.cloud, services.device.id, services.platformKind, setSelectedId]);

  useEffect(() => {
    if (services.platformKind === "android" && !active) return;
    return services.cloud.subscribeDeletedContexts?.(ids => {
    if (!isLive()) return;
    streamVersions.current.deleted += 1;
    void applyDeleted(ids).catch(() => undefined);
    }, () => {
      if (!isLive()) return;
      setSyncStreams(current => ({ ...current, deleted: { confirmed: false, failed: true } }));
      setError("Could not synchronize deletions");
    });
  }, [active, applyDeleted, isLive, services.cloud, services.platformKind]);

  useEffect(() => {
    if (services.platformKind === "android" && !active) return;
    return services.cloud.subscribeDeletedItems?.(records => {
      if (!isLive()) return;
      streamVersions.current.deletedItems += 1;
      void applyDeletedItems(records).catch(() => undefined);
    }, () => {
      if (!isLive()) return;
      setSyncStreams(current => ({ ...current, deletedItems: { confirmed: false, failed: true } }));
      setError("Could not synchronize item deletions");
    });
  }, [active, applyDeletedItems, isLive, services.cloud, services.platformKind]);

  useEffect(() => services.subscribeNavigation?.(id => { if (!isLive()) return; setSelectedId(id); setError(undefined); }), [isLive, services, setSelectedId]);

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
    if (itemStatusScope.current !== selectedId) {
      itemStatusScope.current = selectedId;
      setSyncStreams(current => ({ ...current, items: { fromCache: false, pending: false, failed: false } }));
    }
    if (!selectedId || !selectedContextConfirmed) { setItems([]); return; }
    if (services.platformKind === "android" && !active) return;
    streamVersions.current.items += 1;
    return services.cloud.subscribeItems(selectedId, (snapshot) => {
      if (!isLive() || navigation.selectedRef.current.id !== selectedId) return;
      streamVersions.current.items += 1;
      setItems(snapshot.records.filter(item => !deletedItems.current.has(item.id)));
      setSyncStreams(current => ({ ...current, items: { fromCache: snapshot.fromCache, pending: snapshot.hasPendingWrites, failed: snapshot.fromCache && current.items.failed } }));
      const cloudIds = new Set(snapshot.records.map((item) => item.id));
      setOptimisticItems((current) => current.filter((item) => item.contextId !== selectedId || !cloudIds.has(item.id)));
    }, (cause) => {
      if (!isLive() || navigation.selectedRef.current.id !== selectedId) return;
      streamVersions.current.items += 1;
      setSyncStreams(current => ({ ...current, items: { ...current.items, failed: true } }));
      setError(cause.message || "Could not load shared items");
    });
  }, [active, isLive, navigation.selectedRef, selectedContextConfirmed, selectedId, services.cloud, services.platformKind]);

  const allContexts = [...navigation.localContexts, ...contexts.filter(context => !navigation.localContexts.some(draft => draft.id === context.id))];
  useEffect(() => {
    if (chatMenu && (chatMenu.owner !== services || accountBlocked || panel || !allContexts.some(context => context.id === chatMenu.context.id))) setChatMenu(undefined);
  }, [chatMenu, services, accountBlocked, panel, allContexts]);
  const selected = allContexts.find((context) => context.id === selectedId);
  const visibleContexts = allContexts.filter((context) => context.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const visibleItems = [...items.filter(item => item.contextId === selectedId), ...optimisticItems.filter((item) => item.contextId === selectedId)]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  const scroll = useTimelineScroll(selectedId, visibleItems.map(item => item.id));

  const refresh = useCallback((manual = false): Promise<void> => {
    if (!isLive() || !services.cloud.refreshContexts || !services.cloud.refreshDeletedContexts) return Promise.resolve();
    const selectedAtStart = navigation.selectedRef.current.id;
    const scope = services.viewer.uid;
    let complete = false;
    const reportRefreshError = (message: string) => { refreshError.current = message; setError(message); };
    return catchup.current.run(scope, async owns => {
      const current = () => owns() && isLive();
      if (!current()) return;
      setRefreshing(true);
      if (services.checkAccess) {
        services.pause?.();
        await services.checkAccess();
        if (!current()) return;
      }
      for (const refresher of Object.values(refreshers.current)) refresher.invalidate();
      const versionsAtStart = { ...streamVersions.current };
      suppressCatchupAutoSelect.current = true;
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
          setSyncStreams(current => ({ ...current, contexts: { fromCache: snapshot.fromCache, pending: snapshot.hasPendingWrites, failed: false } }));
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
          setSyncStreams(current => ({ ...current, items: { fromCache: snapshot.fromCache, pending: snapshot.hasPendingWrites, failed: snapshot.fromCache && current.items.failed } }));
        }));
      }
      const results = await Promise.allSettled(tasks);
      if (!current()) return;
      if (results[0]?.status === "rejected" && streamVersions.current.contexts === versionsAtStart.contexts) {
        setSyncStreams(state => ({ ...state, contexts: { ...state.contexts, failed: true } }));
      }
      if (results[3]?.status === "rejected" && navigation.selectedRef.current.id === selectedAtStart && streamVersions.current.items === versionsAtStart.items) {
        setSyncStreams(state => ({ ...state, items: { ...state.items, failed: true } }));
      }
      const deletionReady = results[1]?.status === "fulfilled" && results[2]?.status === "fulfilled";
      if (!deletionReady) setSyncStreams(state => ({ ...state, deleted: { confirmed: false, failed: true } }));
      if (results[2]?.status !== "fulfilled") setSyncStreams(state => ({ ...state, deletedItems: { confirmed: false, failed: true } }));
      if (results.some(result => result.status === "rejected")) {
        reportRefreshError(results.every(result => result.status === "rejected") ? "Could not refresh from the server" : "Some data could not be refreshed");
      } else {
        const previousError = refreshError.current;
        setError(message => message === previousError ? undefined : message);
      }
      if (deletionReady) {
        await deletionCleanup.finish(current, () => {
          setSyncStreams(state => ({ ...state, deleted: { confirmed: true, failed: false }, deletedItems: { confirmed: true, failed: false } }));
          if (services.platformKind === "android" || services.checkAccess) services.resume?.();
        });
      }
      complete = deletionReady && results.every(result => result.status === "fulfilled");
    }, cause => {
      if (!isLive()) return;
      if (cause) {
        setSyncStreams(state => ({ ...state, deleted: { confirmed: false, failed: true } }));
        reportRefreshError(cause instanceof Error ? cause.message : "Could not refresh from the server");
      }
      setRefreshing(false);
      if (manual && !cause && complete) showToast("Refresh complete");
      suppressCatchupAutoSelect.current = backgroundInactive.current;
    });
  }, [applyDeleted, applyDeletedItems, deletionCleanup, isLive, navigation.selectedRef, services, showToast]);

  useEffect(() => {
    if ((!services.checkAccess && services.platformKind !== "android") || signingOut.current) return;
    let current = true;
    if (!active) {
      backgroundInactive.current = true;
      suppressCatchupAutoSelect.current = true;
      catchup.current.invalidate();
      for (const refresher of Object.values(refreshers.current)) refresher.invalidate();
      setRefreshing(false);
      services.pause?.();
      void services.cloud.setNetworkEnabled?.(false)?.catch(() => { if (isLive()) setError("Could not pause network access"); });
      return () => { current = false; };
    }
    backgroundInactive.current = false;
    void Promise.resolve(services.cloud.setNetworkEnabled?.(true)).then(async () => {
      if (!current || !isLive()) return;
      await refresh();
    }).catch(() => {
      if (current && isLive()) setError("Could not restore network access");
    });
    return () => { current = false; };
  }, [active, refresh, services]);
  useEffect(() => {
    if (!active) return;
    const online = () => void refresh();
    window.addEventListener("online", online);
    window.addEventListener("focus", online);
    return () => { window.removeEventListener("online", online); window.removeEventListener("focus", online); };
  }, [active, refresh]);

  const restoreQueued = useCallback(async (selectContext?: Id, selectLatestNative = false, current: () => boolean = () => true) => {
    const queued = (await services.outbox.list()).filter(record => !deleted.current.has(record.contextId));
    if (!current()) return;
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
    if (!isLive()) return;
    const revision = ++queueRefreshRevision.current;
    const queued = await services.outbox.list();
    const deletions = await services.outbox.deletions?.() ?? [];
    if (!isLive() || revision !== queueRefreshRevision.current) return;
    if (deletions.length) setError("Deletion is not confirmed yet. Retry or reconnect to finish.");
    else if (pendingDeletionCount.current) setError(current => current?.startsWith("Deletion is not confirmed") ? undefined : current);
    pendingDeletionCount.current = deletions.length;
    const cancelled = await services.outbox.cancelled?.();
    if (!isLive() || revision !== queueRefreshRevision.current) return;
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
    let subscribed = true;
    let running = false;
    let requested = false;
    const current = () => subscribed && isLive();
    const reconcile = () => {
      requested = true;
      if (running || !current()) return;
      running = true;
      void (async () => {
        try {
          while (requested && current()) {
            requested = false;
            try {
              const contextId = await services.drainNativeShares!();
              if (!current()) return;
              await restoreQueued(contextId, false, current);
              if (current()) await refreshQueue();
            } catch (cause) {
              if (!current()) return;
              // A durable write may have succeeded before native acknowledgement
              // failed. Show that queue without losing the original intake error.
              await restoreQueued(undefined, true, current).catch(() => undefined);
              if (!current()) return;
              await refreshQueue().catch(() => undefined);
              if (!current()) return;
              setError(cause instanceof Error ? cause.message : "Clipboard sharing failed");
              void services.drain().catch(() => undefined);
            }
          }
        } finally { running = false; }
      })();
    };
    // Subscribe first: an event after the native snapshot schedules another read.
    const unsubscribe = services.subscribeNativeShares(reconcile);
    nativeReconcile.current = reconcile;
    if (services.platformKind === "android") reconcile();
    return () => {
      subscribed = false;
      if (nativeReconcile.current === reconcile) nativeReconcile.current = undefined;
      unsubscribe();
    };
  }, [active, isLive, refreshQueue, restoreQueued, services]);

  const share = useCallback((parts: SharePart[], forcedContextId?: Id, sentText?: string, onEnqueueStart?: () => void): Promise<boolean> => {
    const contextId = forcedContextId ?? navigation.selectedRef.current.id;
    if (!parts.length || !isLive() || accountBlocked || deleted.current.has(contextId)) return Promise.resolve(false);
    const operation = (async () => {
      let enqueued = false;
      const createsContext = !contexts.some(context => context.id === contextId) && !localQueuedContexts.current.has(contextId);
      const localTitle = navigation.selectedRef.current.drafts[contextId]?.title;
      const manualTitle = Boolean(createsContext && localTitle && localTitle !== "New context");
      const title = manualTitle ? localTitle! : deriveTitle(parts[0]!.content);
      const now = Date.now();
      try {
        const drafts = parts.map((part, index): ShareDraft => ({
          contextId, itemId: newId(), title, content: ContentSchema.parse(part.content), device: services.device,
          createsContext: createsContext && index === 0,
          ...(manualTitle ? { manualTitle: true } : {}), ...(part.bytes ? { bytes: part.bytes } : {}),
        }));
        if (!isLive() || deleted.current.has(contextId)) return false;
        onEnqueueStart?.();
        if (services.outbox.enqueueBatch) await services.outbox.enqueueBatch(drafts);
        else for (const draft of drafts) await services.outbox.enqueue(draft);
        enqueued = true;
        if (!live.current.mounted || live.current.services !== services || deleted.current.has(contextId)) return true;
        navigation.commit(contextId, sentText);
        if (createsContext) {
          localQueuedContexts.current.add(contextId);
          setContexts(current => [{ id: contextId, title, createdAt: now, updatedAt: now, syncState: "pending" }, ...current.filter(context => context.id !== contextId)]);
        }
        // A late enqueue must never select the captured target again.
        setOptimisticItems(current => [...current, ...drafts.map((draft, index) => ({ id: draft.itemId, contextId, content: draft.content, device: draft.device, createdAt: now + index, ready: draft.content.kind !== "attachment", syncState: "pending" as const }))]);
        scroll.scrollToBottom(contextId);
        await refreshQueue();
        if (isLive()) {
          void services.drain().then(refreshQueue).catch((cause: unknown) => { if (isLive()) setError(cause instanceof Error ? cause.message : "Sharing failed"); });
          showToast("Shared · syncing to your other devices");
        }
        return true;
      } catch (cause) {
        if (live.current.mounted && live.current.services === services) setError(cause instanceof Error ? cause.message : "This item could not be shared");
        return enqueued;
      }
    })();
    pendingPublishes.current.add(operation);
    void operation.finally(() => pendingPublishes.current.delete(operation));
    return operation;
  }, [accountBlocked, contexts, isLive, navigation.commit, navigation.selectedRef, refreshQueue, scroll.scrollToBottom, services, showToast]);

  const captureInput = () => ({
    target: navigation.selectedRef.current.id, owner: services, revision: navigation.revisionRef.current,
    text: navigation.selectedRef.current.drafts[navigation.selectedRef.current.id]?.text ?? "",
    code: navigation.selectedRef.current.drafts[navigation.selectedRef.current.id]?.code ?? false,
    start: textareaRef.current?.selectionStart ?? text.length, end: textareaRef.current?.selectionEnd ?? text.length,
  });
  type InputCapture = ReturnType<typeof captureInput>;
  const ownsInput = (capture: InputCapture) => isLive() && !accountBlocked && capture.owner === live.current.services
    && capture.target === navigation.selectedRef.current.id && capture.revision === navigation.revisionRef.current
    && !deleted.current.has(capture.target)
    && capture.start === (textareaRef.current?.selectionStart ?? capture.start) && capture.end === (textareaRef.current?.selectionEnd ?? capture.end);
  const staleClipboard = () => { if (isLive()) setError("Your chat or draft changed while reading the clipboard. Nothing was sent or replaced. Paste again."); };
  const applyTextPaste = (capture: InputCapture, pasted: string) => {
    if (!ownsInput(capture)) { staleClipboard(); return; }
    const inserted = insertClipboardText(capture, pasted);
    ContentSchema.parse({ kind: capture.code ? "code" : "text", text: inserted.text });
    setText(inserted.text);
    window.setTimeout(() => {
      if (navigation.selectedRef.current.id === capture.target && textareaRef.current?.value === inserted.text) textareaRef.current.setSelectionRange(inserted.caret, inserted.caret);
    }, 0);
  };
  const receivePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault(); if (accountBlocked || !isLive()) return;
    const capture = captureInput();
    const pastedText = event.clipboardData.getData("text/plain");
    const browserFiles = [...event.clipboardData.files];
    try {
      if (!services.readClipboard && !browserFiles.length) { if (pastedText.length) applyTextPaste(capture, pastedText); return; }
      const snapshot: ClipboardSnapshot = services.readClipboard ? await services.readClipboard() : {
        ...(pastedText.length ? { text: pastedText } : {}),
        files: (await fileParts(browserFiles)).flatMap(part => part.content.kind === "attachment" ? [{ name: part.content.name, contentType: part.content.contentType, bytes: part.bytes }] : []),
      };
      if (!ownsInput(capture)) { staleClipboard(); return; }
      if (!snapshot.files.length) { if (snapshot.text?.length) applyTextPaste(capture, snapshot.text); else setError("The clipboard is empty or its format is not supported."); return; }
      const parts = await frozenClipboardParts(snapshot, capture.code);
      if (!ownsInput(capture)) { staleClipboard(); return; }
      openPanel({ kind: "clipboard", snapshot: { id: crypto.randomUUID(), owner: services, target: capture.target, title: displayTitle(allContexts.find(context => context.id === capture.target)?.title), parts } });
    } catch (cause) { if (isLive()) setError(cause instanceof Error ? cause.message : "Could not read the clipboard"); }
  };
  const fastPaste = async () => {
    if (!services.readClipboard || clipboardBusy.current || !isLive() || accountBlocked) return;
    clipboardBusy.current = true; const capture = captureInput();
    try {
      const snapshot = await services.readClipboard();
      const parts = await frozenClipboardParts(snapshot, capture.code);
      if (!ownsInput(capture)) { staleClipboard(); return; }
      if (!parts.length) { setError("The clipboard is empty or its format is not supported."); return; }
      await share(parts, capture.target);
    } catch (cause) { if (isLive()) setError(cause instanceof Error ? cause.message : "Clipboard sharing failed"); }
    finally { clipboardBusy.current = false; }
  };
  const confirmClipboard = async (snapshot: ClipboardConfirmation) => {
    if (binarySent.current.has(snapshot.id) || dialogBusy) return;
    if (!isLive() || snapshot.owner !== services || deleted.current.has(snapshot.target)) { setDialogError("This clipboard request is no longer available. Nothing was sent."); return; }
    binarySent.current.add(snapshot.id); setDialogBusy(true);
    try { if (await share(snapshot.parts, snapshot.target)) closePanel(true); else binarySent.current.delete(snapshot.id); }
    finally { setDialogBusy(false); }
  };
  const sendText = () => {
    const capture = captureInput(), key = `${capture.target}:${capture.revision}`;
    if (!capture.text.length || sendsInFlight.current.has(key)) return;
    sendsInFlight.current.add(key); setSendTick(value => value + 1);
    void share([{ content: { kind: capture.code ? "code" : "text", text: capture.text } }], capture.target, capture.text).finally(() => {
      sendsInFlight.current.delete(key); if (live.current.mounted && live.current.services === services) setSendTick(value => value + 1);
    });
  };
  useEffect(() => { for (const wake of [...pickerWakeups.current]) wake(); }, [active, accountBlocked, services]);
  useEffect(() => () => { for (const wake of [...pickerWakeups.current]) wake(true); }, [services]);
  const ownsPicker = (target: { id: Id; owner: WorkspaceServices }) => live.current.mounted
    && target.owner === services && live.current.services === target.owner && !signingOut.current && !deleted.current.has(target.id);
  const waitForPickerForeground = (target: { id: Id; owner: WorkspaceServices }): Promise<boolean> => new Promise(resolve => {
    const wake = (cancelled = false) => {
      if (cancelled || !ownsPicker(target)) { pickerWakeups.current.delete(wake); resolve(false); }
      else if (isLive()) { pickerWakeups.current.delete(wake); resolve(true); }
    };
    pickerWakeups.current.add(wake); wake();
  });
  const sharePickedFiles = async (files: File[]) => {
    const target = fileTarget.current; fileTarget.current = undefined;
    if (!files.length || !target || !ownsPicker(target)) return;
    try {
      // Android can deliver ActivityResult before its foreground event. Retain
      // the accepted files across that boundary, but never publish in background.
      const parts = await fileParts(files);
      while (await waitForPickerForeground(target)) {
        let enqueueStarted = false;
        if (await share(parts, target.id, undefined, () => { enqueueStarted = true; })) return;
        // A second pause can arrive between waking and enqueue. Keep the
        // same captured bytes until a later resume. An attempted durable
        // write is never repeated here, even if it failed during a pause.
        if (enqueueStarted || isLive() || !ownsPicker(target)) return;
      }
    } catch (cause) {
      if (await waitForPickerForeground(target) && ownsPicker(target)) setError(cause instanceof Error ? cause.message : "Files could not be shared");
    }
  };

  const copyItem = async (item: ItemRecord) => {
    try {
      if (item.content.kind === "attachment") {
        const bytes = await services.cloud.attachmentBytes(item.contextId, item.id, item.content);
        if (!isLive() || deleted.current.has(item.contextId) || deletedItems.current.has(item.id)) return;
        await services.copyFile({ name: item.content.name, contentType: item.content.contentType, bytes });
      } else await services.copyText(item.content.text);
      showToast("Copied to this device");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Copy failed"); }
  };
  const saveItem = async (item: ItemRecord) => {
    if (item.content.kind !== "attachment") return;
    try {
      const bytes = await services.cloud.attachmentBytes(item.contextId, item.id, item.content);
      if (!isLive() || deleted.current.has(item.contextId) || deletedItems.current.has(item.id)) return;
      if (await services.saveFile({ name: item.content.name, contentType: item.content.contentType, bytes })) showToast("File saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Save failed"); }
  };
  const shareItem = async (item: ItemRecord) => {
    if (item.content.kind !== "attachment" || !services.shareFile) return;
    try {
      const bytes = await services.cloud.attachmentBytes(item.contextId, item.id, item.content);
      if (!isLive() || deleted.current.has(item.contextId) || deletedItems.current.has(item.id)) return;
      if (await services.shareFile({ name: item.content.name, contentType: item.content.contentType, bytes })) showToast("Share sheet opened");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Share failed"); }
  };

  const submitRename = async () => {
    if (panel?.kind !== "rename" || accountBlocked) return;
    const target = panel.context;
    const title = renameText.trim().slice(0, 160);
    if (!title) { setDialogError("Enter a chat name."); return; }
    if (deleted.current.has(target.id)) { setDialogError("This chat has been deleted."); return; }
    setDialogBusy(true); setDialogError(undefined);
    try {
      if (navigation.selectedRef.current.drafts[target.id]?.local) navigation.patchFor(target.id, { title });
      else await services.cloud.renameContext(target.id, title);
      if (!isLive()) return;
      setContexts(current => current.map(context => context.id === target.id ? { ...context, title } : context));
      closePanel(true);
    } catch (cause) { if (isLive()) setDialogError(cause instanceof Error ? cause.message : "Rename failed"); }
    finally { setDialogBusy(false); }
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
    if (accountBlocked || !isLive()) return;
    try {
      const complete = await remove(context.id);
      if (!isLive()) return;
      deleted.current.add(context.id); navigation.remove([context.id]);
      setContexts(current => current.filter(c => c.id !== context.id));
      setOptimisticItems(current => current.filter(item => item.contextId !== context.id));
      if (navigation.selectedRef.current.id === context.id) setSelectedId(undefined);
      if (complete) showToast("Context permanently deleted"); else setError("Deletion is not confirmed yet. Retry or reconnect to finish.");
      await refreshQueue();
    } catch { setError("Deletion is not confirmed yet. Retry or reconnect to finish."); }
  };
  const deleteItem = async (item: ItemRecord) => {
    try {
      const complete = await remove(item.contextId, item.id);
      if (!isLive()) return;
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
    nativeReconcile.current?.();
    try { await refresh(); for (const action of fallbackDeletes.current.values()) await action(); await services.outbox.retry(); await services.drain(); await refreshQueue(); }
    catch { setError("Operation is not confirmed yet. Reconnect and retry."); }
  };

  const settleLocalInput = async () => {
    await Promise.all([...pendingPublishes.current]);
    await navigation.flush();
  };
  const prepareSignOut = async () => {
    if (dialogBusy) return;
    openPanel({ kind: "signout" }); setDialogBusy(true); setSignOutSummary(undefined);
    const owner = services;
    try {
      const summary = await signOutFlow.prepare(settleLocalInput);
      if (live.current.services === owner && live.current.mounted) setSignOutSummary(summary);
    } catch (cause) {
      if (live.current.services === owner && live.current.mounted) setDialogError(cause instanceof Error ? cause.message : "Could not read local data. Nothing was cleared.");
    } finally { if (live.current.services === owner && live.current.mounted) setDialogBusy(false); }
  };
  const completeSignOut = async (retry = false) => {
    if (dialogBusy || (!retry && !signOutSummary)) return;
    const owner = services;
    signingOut.current = true; setAccountBlocked(true); setDialogBusy(true); setDialogError(undefined);
    try {
      const result = retry ? await signOutFlow.retry() : await signOutFlow.confirm(signOutSummary!, settleLocalInput);
      if (live.current.services !== owner || !live.current.mounted) return;
      if (result.status === "changed") { setSignOutSummary(result.summary); setDialogError("Local data changed. Review the updated counts before confirming again."); }
      else if (services.platformKind !== "browser") { window.location.reload(); }
    } catch (cause) {
      if (live.current.services === owner && live.current.mounted) setDialogError(cause instanceof Error ? cause.message : "Sign-out is incomplete. Retry to finish.");
    } finally {
      if (live.current.services === owner && live.current.mounted) { signingOut.current = signOutFlow.locked; setAccountBlocked(signOutFlow.locked); setDialogBusy(false); if (!signOutFlow.locked) { void refresh(); nativeReconcile.current?.(); } }
    }
  };

  const pendingWrites = syncStreams.contexts.pending || syncStreams.items.pending;
  const fromCache = syncStreams.contexts.fromCache || syncStreams.items.fromCache;
  const syncLabel = refreshing ? "Refreshing…" : queueCount > 0 || pendingWrites ? `Syncing ${Math.max(queueCount, 1)} item${Math.max(queueCount, 1) === 1 ? "" : "s"}`
    : fromCache ? "Offline history" : syncStreams.contexts.failed || syncStreams.items.failed || syncStreams.deleted.failed || !syncStreams.deleted.confirmed || syncStreams.deletedItems.failed || !syncStreams.deletedItems.confirmed ? "Sync incomplete" : "Synced";

  const openChatMenu = (context: ContextRecord, anchor: ChatMenuAnchor, opener: HTMLElement) => {
    if (!accountBlocked) setChatMenu({ context, anchor, opener, owner: services });
  };
  const renameChat = (context: ContextRecord) => {
    setRenameText(context.title === "New context" ? "" : context.title);
    openPanel({ kind: "rename", context });
  };
  const copyChatLink = (context: ContextRecord) => {
    void services.copyText(`${services.appOrigin ?? location.origin}/contexts/${context.id}`).then(() => { if (isLive()) showToast("Chat link copied"); }).catch(cause => { if (isLive()) setError(cause instanceof Error ? cause.message : "Could not copy the link"); });
  };
  const panelTitle = panel?.kind === "context" ? "Chat options" : panel?.kind === "rename" ? "Rename chat" : panel?.kind === "delete-context" ? "Delete chat?" : panel?.kind === "item" ? "Message options" : panel?.kind === "delete-item" ? "Delete message?" : panel?.kind === "clipboard" ? "Send pasted files?" : panel?.kind === "add" ? "Add to this chat" : panel?.kind === "signout" ? "Sign out?" : "Settings";
  const option = (icon: Parameters<typeof WorkspaceIcon>[0]["name"], label: string, action: () => void, disabled = false, description?: string) => <button type="button" className={`dialog-action ${icon === "trash" ? "danger" : ""}`} onClick={action} disabled={disabled || dialogBusy}><WorkspaceIcon name={icon} /><span>{label}{description ? <small>{description}</small> : null}</span></button>;
  const confirmDelete = async () => {
    if (!panel || dialogBusy) return;
    setDialogBusy(true);
    try {
      if (panel.kind === "delete-context") await deleteContext(panel.context);
      if (panel.kind === "delete-item") await deleteItem(panel.item);
      closePanel(true);
    } finally { setDialogBusy(false); }
  };

  return <>
    <div ref={backgroundRef} className={`app-shell ${compact && drawerOpen ? "drawer-open" : ""}`}>
      {compact && drawerOpen ? <button className="drawer-backdrop" type="button" tabIndex={-1} aria-label="Close chats menu backdrop" onClick={() => closeDrawer()} /> : null}
      <ChatSidebar elementRef={sidebarRef} compact={compact} open={drawerOpen} contexts={visibleContexts} selectedId={selectedId} search={search} onSearch={setSearch}
        onSelect={id => { if (!accountBlocked) { setSelectedId(id); closeDrawer(false); } }}
        onNew={() => { if (!accountBlocked) { setSelectedId(undefined); setError(undefined); closeDrawer(false); window.setTimeout(() => textareaRef.current?.focus(), 0); } }}
        onClose={() => closeDrawer()} onOptions={(context, opener) => {
          if (services.platformKind === "android" || window.matchMedia?.("(pointer: coarse)").matches) openPanel({ kind: "context", context });
          else { const rect = opener.getBoundingClientRect(); openChatMenu(context, { x: rect.left, y: rect.bottom }, opener); }
        }} onContextMenu={openChatMenu} onSettings={() => openPanel({ kind: "settings" })}
        onRefresh={() => void refresh(true)} refreshing={refreshing} blocked={accountBlocked} name={viewer.name} email={viewer.email} />
      <SidebarResize accountId={services.viewer.uid} compact={compact} sidebarRef={sidebarRef} />
      <main ref={mainRef} className="main-panel">
        <ChatTopbar title={selected?.title} status={syncLabel} offline={fromCache} drawerOpen={drawerOpen} menuRef={menuRef} onMenu={() => setDrawerOpen(true)} onRefresh={() => void refresh(true)}
          onOptions={() => openPanel({ kind: "context", context: selected ?? { id: selectedId, title: "New context", createdAt: Date.now(), updatedAt: Date.now(), syncState: "pending" } })} refreshing={refreshing} blocked={accountBlocked} />
        {error || navigation.issue ? <div className="error-banner" role="alert"><span>{error ?? navigation.issue}</span><button type="button" disabled={accountBlocked} onClick={() => void retry()}>Retry</button>{error ? <button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError(undefined)}><WorkspaceIcon name="close" /></button> : null}</div> : null}
        <div className="timeline-region">
          <section ref={scroll.viewport} className="timeline" aria-label="Messages to yourself"><div ref={scroll.content} className="timeline-content">
            {visibleItems.length ? visibleItems.map((item, index) => <Fragment key={item.id}>{index === 0 || dayLabel(visibleItems[index - 1]!.createdAt) !== dayLabel(item.createdAt) ? <div className="day-label">{dayLabel(item.createdAt)}</div> : null}<ChatMessage item={item} cloud={services.cloud} blocked={accountBlocked} onCopy={value => void copyItem(value)} onMore={item => openPanel({ kind: "item", item })} /></Fragment>)
              : <div className="empty"><WorkspaceIcon name="stack" /><strong>A place for your thoughts.</strong><span>Message yourself. Send it to pick it up on another device.</span></div>}
          </div></section>
          {scroll.newMessages ? <button type="button" className="new-messages" onClick={() => scroll.scrollToBottom(selectedId)}>New messages <WorkspaceIcon name="save" /></button> : null}
        </div>
        <ChatComposer text={text} code={codeMode} android={services.platformKind === "android"} nativeClipboard={!!services.readClipboard} blocked={accountBlocked} sending={sendsInFlight.current.has(`${selectedId}:${navigation.revisionRef.current}`)} textareaRef={textareaRef}
          onText={value => { if (!accountBlocked) setText(value); }} onPaste={event => { void receivePaste(event); }} onKey={event => {
            if (keyboardSends({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 }, services.platformKind === "android", codeMode)) { event.preventDefault(); sendText(); }
          }} onAdd={() => openPanel({ kind: "add", contextId: selectedId, title: displayTitle(selected?.title) })} onCodeOff={() => setCodeMode(() => false)} onFastPaste={() => void fastPaste()} onSend={sendText} />
        <input ref={fileInput} type="file" multiple hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void sharePickedFiles(files); }} />
      </main>
    </div>
    {chatMenu && chatMenu.owner === services && !panel && !accountBlocked ? <ChatContextMenu context={chatMenu.context} anchor={chatMenu.anchor} opener={chatMenu.opener} onClose={() => setChatMenu(undefined)} onRename={renameChat} onDelete={context => openPanel({ kind: "delete-context", context })} onCopy={navigation.selectedRef.current.drafts[chatMenu.context.id]?.local ? undefined : copyChatLink} /> : null}
    {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
    {panel ? <WorkspaceDialog title={panelTitle} viewKey={panel.kind} backgroundRef={backgroundRef} busy={dialogBusy || accountBlocked} onClose={() => closePanel()}>
      {panel.kind === "context" ? <>
        <p className="dialog-description">{displayTitle(panel.context.title)}</p>
        {option("edit", "Rename chat", () => renameChat(panel.context))}
        {!navigation.selectedRef.current.drafts[panel.context.id]?.local ? option("link", "Copy link", () => { copyChatLink(panel.context); closePanel(); }, false, "The link does not give other accounts access.") : null}
        {!services.isDesktop && services.platformKind !== "android" && !navigation.selectedRef.current.drafts[panel.context.id]?.local ? <a className="dialog-action" href={`multi-device-context://context/${panel.context.id}`}><WorkspaceIcon name="share" /><span>Open in app</span></a> : null}
        <div className="dialog-divider" />{option("trash", "Delete chat…", () => setPanel({ kind: "delete-context", context: panel.context }))}
      </> : null}
      {panel.kind === "rename" ? <form className="rename-form" onSubmit={event => { event.preventDefault(); void submitRename(); }}><label htmlFor="chat-name">Chat name</label><input id="chat-name" className="rename-input" aria-label="Chat name" maxLength={160} value={renameText} onChange={event => setRenameText(event.target.value)} disabled={dialogBusy} /><div className="dialog-buttons"><button type="button" disabled={dialogBusy} onClick={() => closePanel()}>Cancel</button><button type="submit" className="primary" disabled={dialogBusy || !renameText.trim()}>Save</button></div></form> : null}
      {panel.kind === "item" ? <>
        <p className="dialog-description">{panel.item.content.kind === "attachment" ? panel.item.content.name : `${panel.item.device.name} · ${formatTime(panel.item.createdAt)}`}</p>
        {option("copy", panel.item.content.kind === "attachment" ? "Copy file" : "Copy message", () => { void copyItem(panel.item); closePanel(); }, panel.item.content.kind === "attachment" && !panel.item.ready)}
        {panel.item.content.kind === "attachment" ? <>{option("save", "Save to this device…", () => { void saveItem(panel.item); closePanel(); }, !panel.item.ready)}{services.shareFile ? option("share", "Share through Android…", () => { void shareItem(panel.item); closePanel(); }, !panel.item.ready) : null}</> : null}
        <div className="dialog-divider" />{option("trash", "Delete message…", () => setPanel({ kind: "delete-item", item: panel.item }))}
      </> : null}
      {panel.kind === "delete-context" || panel.kind === "delete-item" ? <><p className="dialog-description">{panel.kind === "delete-context" ? `“${displayTitle(panel.context.title)}” and all its messages will be permanently deleted from your devices.` : `${panel.item.content.kind === "attachment" ? `“${panel.item.content.name}”` : "This message"} will be permanently deleted from this chat on your devices.`} There is no undo.</p><div className="dialog-buttons"><button type="button" disabled={dialogBusy} onClick={() => closePanel()}>Cancel</button><button type="button" className="destructive" disabled={dialogBusy} onClick={() => void confirmDelete()}>{panel.kind === "delete-context" ? "Delete chat" : "Delete message"}</button></div></> : null}
      {panel.kind === "clipboard" ? <>
        <p className="dialog-description">Send this captured clipboard content to <strong>{panel.snapshot.title}</strong>? Your typed draft stays unchanged.</p>
        <ul className="clipboard-files">{panel.snapshot.parts.map((part, index) => <li key={index}>{part.content.kind === "attachment" ? <><WorkspaceIcon name="file" /><span>{part.content.name}<small>{formatFileSize(part.content.size)}</small></span></> : <p className="clipboard-text">{part.content.text}</p>}</li>)}</ul>
        <div className="dialog-buttons"><button type="button" disabled={dialogBusy} onClick={() => closePanel()}>Cancel</button><button type="button" className="primary" disabled={dialogBusy || deleted.current.has(panel.snapshot.target)} onClick={() => void confirmClipboard(panel.snapshot)}>Send files</button></div>
      </> : null}
      {panel.kind === "add" ? <>
        <p className="dialog-description">{panel.title}</p>
        {option("file", "Choose and send files…", () => { fileTarget.current = { id: panel.contextId, owner: services }; closePanel(); fileInput.current?.click(); }, false, "Selected files are sent immediately to this chat.")}
        <button type="button" className="dialog-action" aria-label="Code mode" aria-pressed={navigation.selectedRef.current.drafts[panel.contextId]?.code ?? false} onClick={() => { if (!deleted.current.has(panel.contextId)) navigation.patchFor(panel.contextId, { code: !navigation.selectedRef.current.drafts[panel.contextId]?.code }); closePanel(); }}><WorkspaceIcon name="code" /><span>Code mode<small>{navigation.selectedRef.current.drafts[panel.contextId]?.code ? "On" : "Off"} · Applies to typed and pasted text</small></span></button>
      </> : null}
      {panel.kind === "settings" ? <>
        <div className="profile-row"><span className="avatar large">{viewer.name.charAt(0).toUpperCase()}</span><span><strong>{viewer.name}</strong><small>{viewer.email ?? "Account details unavailable"}</small></span></div>
        <label className="setting-row"><span>Theme<small>Choose how your chats look.</small></span><select value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        {services.platformKind !== "android" ? <label className="setting-row"><span>Launch at login<small>{services.setLaunchAtLogin ? "Start with this computer." : "Available in the desktop app."}</small></span><input type="checkbox" disabled={!services.setLaunchAtLogin || launchAtLogin === undefined} checked={launchAtLogin ?? false} onChange={event => { const enabled = event.target.checked; setLaunchAtLoginState(enabled); void services.setLaunchAtLogin?.(enabled).catch(() => { if (isLive()) setError("Could not change the startup setting"); }); }} /></label> : null}
        {services.settings ? <label className="setting-row"><span>AI context titles<small>Send the first text (up to 8,000 characters), or filename/type, to OpenRouter. File bytes are never sent. Turning off prevents new requests; already sent requests cannot be recalled. This does not add AI replies.</small></span><input aria-label="AI context titles" type="checkbox" disabled={aiEnabled === undefined || services.accessMode === "own"} checked={aiEnabled ?? false} onChange={event => { const enabled = event.target.checked; setAiEnabled(undefined); void services.settings!.setSettings(enabled).then(value => { if (isLive()) setAiEnabled(value.aiTitlesEnabled); }).catch(() => { if (isLive()) setError("Could not save AI setting. Reopen Settings to retry."); }); }} /></label> : null}
        <div className="privacy-note">Incoming items stay here until you explicitly choose Copy. Other accounts cannot access your contexts. Service operators process data; this is not end-to-end encryption.</div>
        {services.openAccessPanel ? <><div className="setting-row"><span>Device access<small>{services.accessMode === "all" ? "All contexts" : "Only contexts created on this device"}</small></span></div><button type="button" className="dialog-action" onClick={() => void services.openAccessPanel!().catch(cause => setError(cause instanceof Error ? cause.message : "Could not open device access"))}>Manage device access…</button></> : null}
        <button type="button" className="signout" onClick={() => void prepareSignOut()}>Sign out</button>
      </> : null}
      {panel.kind === "signout" ? <>
        <p className="dialog-description">Signing out removes this account’s local drafts and pending work from this device. Messages already synchronized remain on your other devices.</p>
        {signOutSummary ? <dl className="signout-counts"><div><dt>Unsent drafts</dt><dd>{signOutSummary.drafts}</dd></div><div><dt>Queued messages and files</dt><dd>{signOutSummary.webShares}</dd></div><div><dt>Incoming native share batches</dt><dd>{signOutSummary.nativeBatches}</dd></div><div><dt>Unfinished deletions</dt><dd>{signOutSummary.deletions}</dd></div></dl> : <p>{dialogBusy ? "Checking local data…" : "Local data could not be checked. No cleanup was performed."}</p>}
        <div className="dialog-buttons"><button type="button" disabled={dialogBusy || accountBlocked} onClick={() => closePanel()}>Cancel</button>
          {signOutSummary ? <button type="button" className="destructive" disabled={dialogBusy} onClick={() => void completeSignOut()}>Confirm sign out</button> : <button type="button" disabled={dialogBusy} onClick={() => void prepareSignOut()}>Retry checking data</button>}
          {accountBlocked && dialogError ? <button type="button" disabled={dialogBusy} onClick={() => void completeSignOut(true)}>Retry sign out</button> : null}
        </div>
      </> : null}
      {dialogError ? <p className="dialog-error" role="alert">{dialogError}</p> : null}
    </WorkspaceDialog> : null}
  </>;
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

type WorkspaceBundle = { services: WorkspaceServices; invalidate(): void; settle(): Promise<void>; dispose(): void };
export async function buildServices(session: ActiveSession, onAccessChange: () => void): Promise<WorkspaceBundle> {
  const native = session.platform.native;
  const device = { id: session.device.id, name: session.device.name };
  await prepareHistory(session.firebaseApp);
  const cloud = new FirebaseCloud(session.firebaseApp, session.uid, session.accessToken, session.device);
  const outbox = new DurableOutbox({ projectId: session.config.firebase.projectId, uid: session.uid });
  let accessActive = true;
  let checkPending: Promise<void> | undefined;
  const checkAccess = (): Promise<void> => {
    if (!accessActive) return Promise.reject(new Error("Device access changed. Refresh to continue."));
    if (!checkPending) {
      const operation = cloud.refreshDevice().then(current => {
        if (current.id !== device.id || current.version !== session.device.version || current.mode !== session.device.mode) {
          invalidate(); onAccessChange(); throw new Error("Device access changed. Reloading your contexts.");
        }
      });
      checkPending = operation;
      void operation.finally(() => { if (checkPending === operation) checkPending = undefined; }).catch(() => {});
    }
    return checkPending;
  };
  // Durable local fences are installed before intake or publishing can restore old work.
  const verifiedPolicy = await cloud.refreshDevice();
  if (verifiedPolicy.id !== device.id || verifiedPolicy.version !== session.device.version || verifiedPolicy.mode !== session.device.mode) {
    cloud.invalidate(); outbox.close(); onAccessChange(); throw new Error("Device access changed. Reloading your contexts.");
  }
  const initialContexts = await cloud.refreshContexts();
  await applyLocalAccess(outbox.namespace, session.device, initialContexts.records.filter(context => context.originDeviceId === device.id).map(context => context.id));
  if (session.device.mode === "own") {
    localStorage.removeItem(`mdc-confirmed:${outbox.namespace}`);
    localStorage.removeItem(`mdc-read:${session.uid}:${device.id}`);
  }
  const operations = new ContextOperations(outbox, {
    deletionMarkers: async () => { await checkAccess(); return cloud.deletionMarkers(); },
    publish: record => cloud.publish(record), deleteContext: id => cloud.deleteContext(id), deleteItem: (id, item) => cloud.deleteItem(id, item),
  });
  const runner = operations.runner;
  runner.stop();
  let lastNativeContext: Id | undefined;
  let nativeIntakeEnabled = true;
  let nativeDrainRequested = false;
  let nativeDrainPending: Promise<Id | undefined> | undefined;
  let transferInvalidation: Promise<void> = Promise.resolve();
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
  const drainNative = (): Promise<Id | undefined> => {
    if (!native || !nativeIntakeEnabled) return Promise.resolve(undefined);
    nativeDrainRequested = true;
    if (nativeDrainPending) return nativeDrainPending;
    lastNativeContext = undefined;
    nativeDrainPending = (async () => {
      do {
        nativeDrainRequested = false;
        await drainNativeClipboardQueue(native, nativeStore, () => nativeIntakeEnabled);
      } while (nativeDrainRequested && nativeIntakeEnabled);
      return nativeIntakeEnabled ? lastNativeContext : undefined;
    })().finally(() => { nativeDrainPending = undefined; });
    return nativeDrainPending;
  };
  function invalidate() {
    if (!accessActive) return;
    accessActive = false; nativeIntakeEnabled = false; runner.stop(); cloud.invalidate();
    transferInvalidation = session.platform.invalidateTransfers?.() ?? Promise.resolve();
    void transferInvalidation.catch(() => {});
  }
  await checkAccess();
  const initialNativeId = await drainNative();
  let activityActive = session.platform.activity?.initialActive ?? true;
  const stopActivity = session.platform.activity?.subscribe(value => { activityActive = value; });
  const accountSignOut = createAccountSignOut({
    namespace: outbox.namespace,
    checkAvailable: () => session.platform.assertCanSignOut?.(),
    ...(native ? { readNativeRequests: () => native.getPendingClipboardShares() } : {}),
    pause: () => {
      const wasStopped = runner.stopped, previousIntake = nativeIntakeEnabled;
      nativeIntakeEnabled = false; runner.stop();
      return () => { nativeIntakeEnabled = previousIntake; if (!wasStopped && activityActive) runner.resume(); };
    },
    settle: async () => { await Promise.all([runner.stopAndWait(), nativeDrainPending ?? Promise.resolve()]); },
    signOut: (cleanup, nativeIds) => { accessActive = false; cloud.invalidate(); return session.signOut(cleanup, nativeIds); },
  });
  const initialNavigation = await native?.takeNavigation?.();
  if (initialNavigation && !initialNavigation.contextId && !initialNativeId) window.history.replaceState({}, "", "/");
  // Every platform starts paused until policy verification, scoped reads and durable cleanup finish.
  runner.stop();
  const stopLocalPolicy = subscribeLocal(() => {
    void readLocalAccess(outbox.namespace).then(local => {
      if (accessActive && !accountSignOut.locked && local && (local.deviceId !== device.id || local.version > session.device.version || local.mode !== session.device.mode)) { invalidate(); onAccessChange(); }
    }).catch(() => { if (accessActive) { invalidate(); onAccessChange(); } });
  });
  const stopPolicy = cloud.subscribeDevice(current => {
    if (!accessActive || accountSignOut.locked) return;
    if (current.id !== device.id || current.version !== session.device.version || current.mode !== session.device.mode) { invalidate(); onAccessChange(); }
  }, () => { if (accessActive && !accountSignOut.locked) { invalidate(); onAccessChange(); } });
  return {
    services: {
      ...(initialNavigation?.contextId || initialNativeId ? { initialContextId: initialNavigation?.contextId ?? initialNativeId! } : {}),
      accessMode: session.device.mode,
      accessActive: () => accessActive,
      checkAccess,
      openAccessPanel: async () => {
        if (session.platform.openAccessPanel) await session.platform.openAccessPanel(device.id);
        else window.open(`${session.config.appOrigin}/access?device=${encodeURIComponent(device.id)}`, "_blank", "noopener,noreferrer");
      },
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
      ...(session.profile ? { profile: session.profile } : {}),
      device,
      cloud,
      outbox,
      drain: () => accountSignOut.locked || !accessActive ? Promise.resolve() : runner.drain(),
      pause: () => runner.stop(),
      resume: () => { if (!accountSignOut.locked && accessActive) runner.resume(); },
      copyText: native ? (value) => native.copyText(value) : (value) => navigator.clipboard.writeText(value),
      copyFile: native ? (file) => native.copyFile(file) : browserCopyFile,
      saveFile: native ? (file) => native.saveFile(file) : browserSaveFile,
      ...(session.platform.shareFile ? { shareFile: session.platform.shareFile } : {}),
      accountSignOut,
      signOut: async () => { throw new Error("Use the reviewed sign-out flow."); },
      ...(native ? {
        ...(native.getLaunchAtLogin ? { getLaunchAtLogin: () => native.getLaunchAtLogin!() } : {}),
        ...(native.setLaunchAtLogin ? { setLaunchAtLogin: (enabled: boolean) => native.setLaunchAtLogin!(enabled) } : {}),
        pendingNativeCount: async () => (await native.getPendingClipboardShares()).length,
        readClipboard: () => native.readClipboard(),
        subscribeNativeShares: (listener: () => void) => native.onShareClipboard(listener),
        drainNativeShares: async () => {
          const contextId = await drainNative();
          if (nativeIntakeEnabled) window.setTimeout(() => {
            if (nativeIntakeEnabled) void runner.drain().catch(() => undefined);
          }, 0);
          return contextId;
        },
      } : {}),
    },
    invalidate,
    settle: async () => { await Promise.all([runner.stopAndWait(), nativeDrainPending ?? Promise.resolve(), transferInvalidation]); },
    dispose: () => { stopPolicy(); stopLocalPolicy(); stopActivity?.(); nativeIntakeEnabled = false; accessActive = false; cloud.invalidate(); runner.stop(); outbox.close(); },
  };
}

function WorkspaceApp() {
  const manager = useMemo(() => new SessionManager(), []);
  const [session, setSession] = useState<ActiveSession>();
  const [workspace, setWorkspace] = useState<WorkspaceBundle>();
  const workspaceRef = useRef<WorkspaceBundle | undefined>(undefined);
  const lastBuiltSession = useRef<ActiveSession | undefined>(undefined);
  const changing = useRef<Promise<void> | undefined>(undefined);
  const [state, setState] = useState<"loading" | "login" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  const reloadAccess = useCallback(() => {
    if (changing.current) return;
    const previous = workspaceRef.current;
    previous?.invalidate();
    setState("loading");
    const operation = (async () => {
      const next = await manager.restartDataSession();
      await previous?.settle(); previous?.dispose(); workspaceRef.current = undefined;
      setWorkspace(undefined); setSession(next);
    })().catch(cause => { setError(cause instanceof Error ? cause.message : "Could not verify device access"); setState("error"); });
    changing.current = operation;
    void operation.finally(() => { if (changing.current === operation) changing.current = undefined; });
  }, [manager]);

  const start = useCallback(async () => {
    setState("loading"); setError(undefined);
    try {
      await manager.prepare();
      let restored = await manager.restore();
      if (restored && restored === lastBuiltSession.current) { workspaceRef.current?.invalidate(); restored = await manager.restartDataSession(); await workspaceRef.current?.settle(); }
      if (!restored) { setState("login"); return; }
      setSession(restored);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Contexts is unavailable"); setState("error"); }
  }, [manager]);
  useEffect(() => { void start(); }, [start]);
  useEffect(() => {
    if (!session) return;
    lastBuiltSession.current = session;
    let cancelled = false;
    void buildServices(session, reloadAccess).then((created) => {
      if (cancelled) created.dispose(); else { workspaceRef.current = created; setWorkspace(created); setState("ready"); }
    }).catch((cause: unknown) => { if (cancelled) return; setError(cause instanceof Error ? cause.message : "Could not start synchronization"); setState("error"); });
    return () => { cancelled = true; };
  }, [session, reloadAccess]);
  useEffect(() => () => workspace?.dispose(), [workspace]);

  if (state === "ready" && workspace) return <ContextWorkspace services={workspace.services} />;
  return <main className="gate"><div className="gate-card"><div className="brand gate-brand"><span className="brand-mark"><Icon>▦</Icon></span>Contexts</div>
    {state === "loading" ? <><div className="spinner" /><h1>Connecting your contexts</h1><p>Restoring your private, synchronized history.</p></> : null}
    {state === "login" ? <><h1>Move a thought between your computers.</h1><p>Sign in with your Google account. Your contexts are isolated from other accounts. AI titles are optional; service operators process stored data.</p><button type="button" className="login-button" onClick={() => void manager.login().then((active) => { if (active) setSession(active); }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Sign in failed"); setState("error"); })}>Continue with Google</button></> : null}
    {state === "error" ? <><h1>Contexts is unavailable</h1><p role="alert">{error}</p><button type="button" className="login-button" onClick={() => void start()}>Retry</button></> : null}
  </div></main>;
}

export default function App() {
  return isAccessPageRequest() ? <AccessPage /> : <WorkspaceApp />;
}
