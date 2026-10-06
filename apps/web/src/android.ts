import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { ContentSchema, DeviceSchema, IdSchema, MAX_ATTACHMENT_BYTES, MAX_TEXT_BYTES, UpdateStateSchema, type ClipboardSnapshot, type NativeFile, type PendingClipboardShare, type UpdateState } from "@mdc/contracts";
import type { PlatformAdapter } from "./platform.js";

type ListenerHandle = { remove(): Promise<void> };
type Navigation = { contextId?: string };
export type NativeFileRef = { id: string; name: string; contentType: string; size: number; path: string };
type NativeSnapshot = { text?: string; files: NativeFileRef[] };
type NativeRequest = NativeSnapshot & { id: string; capturedAt: number };
export interface MdcNativePlugin {
  getDevice(): Promise<{ id: string; name: string }>;
  exchangeInstallationSession(options: { accessToken: string }): Promise<unknown>;
  openAccessPanel(options: { deviceId: string }): Promise<void>;
  invalidateTransfers(): Promise<void>;
  getAccessToken(options: { interactive: boolean }): Promise<{ accessToken: string }>;
  signOut(options: { reviewedNativeIds: readonly string[] }): Promise<void>;
  readClipboard(): Promise<NativeSnapshot>;
  copyText(options: { text: string }): Promise<void>;
  beginFile(options: { name: string; contentType: string }): Promise<{ id: string }>;
  appendFile(options: { id: string; base64: string }): Promise<void>;
  finishFile(options: { id: string; action: "copy" | "save" | "share" }): Promise<{ saved: boolean }>;
  discardFile(options: { id: string }): Promise<void>;
  getPendingShares(): Promise<{ requests: NativeRequest[] }>;
  acknowledgeShare(options: { id: string }): Promise<void>;
  takeNavigation(): Promise<Navigation>;
  getUpdateState(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  startUpdate(): Promise<unknown>;
  installUpdate(): Promise<void>;
  addListener(event: "shareReceived" | "navigate" | "updateState", listener: (event: any) => void): Promise<ListenerHandle>;
}
export type AndroidDependencies = {
  plugin: MdcNativePlugin;
  app: {
    getState(): Promise<{ isActive: boolean }>;
    minimizeApp(): Promise<void>;
    addListener(event: "appStateChange", listener: (event: { isActive: boolean }) => void): Promise<ListenerHandle>;
    addListener(event: "backButton", listener: (event: { canGoBack: boolean }) => void): Promise<ListenerHandle>;
  };
  convertFileSrc(path: string): string;
  fetcher: typeof fetch;
};
const CHUNK_BYTES = 256 * 1024;
const INBOX_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();

function validateText(text: unknown): asserts text is string | undefined {
  if (text !== undefined && (typeof text !== "string" || encoder.encode(text).byteLength > MAX_TEXT_BYTES)) throw new Error("Shared text exceeds the allowed size");
}
function validateSnapshot(snapshot: NativeSnapshot): number {
  validateText(snapshot.text);
  if (!Array.isArray(snapshot.files) || snapshot.files.length > 32) throw new Error("Too many shared files");
  let size = 0;
  for (const file of snapshot.files) {
    ContentSchema.parse({ kind: "attachment", name: file.name, contentType: file.contentType, size: file.size });
    if (typeof file.id !== "string" || !file.id || typeof file.path !== "string" || !file.path.startsWith("file:///") || /[\u0000\r\n]/u.test(file.path) || file.path.split("/").includes("..")) throw new Error("Invalid private file reference");
    size += file.size;
  }
  if (size > MAX_ATTACHMENT_BYTES) throw new Error("Shared files exceed the allowed size");
  return size + encoder.encode(snapshot.text ?? "").byteLength;
}
function encodeChunk(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function navigation(event: Navigation): Navigation | undefined {
  if (event.contextId === undefined) return undefined;
  const id = IdSchema.safeParse(event.contextId);
  return id.success ? { contextId: id.data } : undefined;
}

export async function createAndroidPlatform(): Promise<PlatformAdapter> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") throw new Error("Open this build in the Android app");
  return createAndroidAdapter({ plugin: registerPlugin<MdcNativePlugin>("MdcNative"), app: App, convertFileSrc: path => Capacitor.convertFileSrc(path), fetcher: fetch });
}

export async function createAndroidAdapter({ plugin, app, convertFileSrc, fetcher }: AndroidDependencies): Promise<PlatformAdapter> {
  let disposed = false;
  let generation = 0;
  let controller = new AbortController();
  let active = true;
  let stateEvents = 0;
  let pending: Promise<PendingClipboardShare[]> | undefined;
  const activityListeners = new Set<(active: boolean) => void>();
  const shareListeners = new Set<() => void>();
  const navigationListeners = new Set<(event: Navigation) => void>();
  const updateListeners = new Set<(state: UpdateState) => void>();
  const handles: ListenerHandle[] = [];
  const ensureCurrent = (expected = generation) => { if (disposed || expected !== generation) throw new Error("Android operation was cancelled"); };
  const subscribe = <T>(listeners: Set<T>, listener: T): (() => void) => {
    ensureCurrent(); listeners.add(listener); return () => { listeners.delete(listener); };
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; generation++; controller.abort();
    activityListeners.clear(); shareListeners.clear(); navigationListeners.clear(); updateListeners.clear();
    for (const handle of handles) void handle.remove().catch(() => {});
  };
  try {
    handles.push(await app.addListener("appStateChange", event => {
      if (disposed) return;
      stateEvents++; active = event.isActive;
      for (const listener of activityListeners) listener(active);
    }));
    handles.push(await app.addListener("backButton", event => {
      if (disposed || !window.dispatchEvent(new Event("mdc:back", { cancelable: true }))) return;
      if (event.canGoBack) window.history.back();
      else void app.minimizeApp().catch(() => {});
    }));
    const beforeState = stateEvents;
    const initial = await app.getState();
    if (beforeState === stateEvents) active = initial.isActive;
    handles.push(await plugin.addListener("shareReceived", () => { if (!disposed) for (const listener of shareListeners) listener(); }));
    handles.push(await plugin.addListener("navigate", event => {
      const value = navigation(event);
      if (!disposed && value) for (const listener of navigationListeners) listener(value);
    }));
    handles.push(await plugin.addListener("updateState", event => {
      if (disposed) return;
      const state = UpdateStateSchema.safeParse(event);
      if (state.success) for (const listener of updateListeners) listener(state.data);
    }));
  } catch (error) { dispose(); throw error; }

  async function readFile(file: NativeFileRef, expected: number): Promise<NativeFile> {
    ensureCurrent(expected);
    const response = await fetcher(convertFileSrc(file.path), { signal: controller.signal });
    if (!response.ok) throw new Error("Shared file is unavailable");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== file.size) throw new Error("Shared file size changed");
    const bytes = new Uint8Array(file.size);
    let offset = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          ensureCurrent(expected);
          const next = await reader.read();
          if (next.done) break;
          if (offset + next.value.byteLength > file.size) throw new Error("Shared file size changed");
          bytes.set(next.value, offset); offset += next.value.byteLength;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else {
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.length !== file.size) throw new Error("Shared file size changed");
      bytes.set(body); offset = body.length;
    }
    ensureCurrent(expected);
    if (offset !== file.size) throw new Error("Shared file size changed");
    return { name: file.name, contentType: file.contentType, bytes };
  }
  async function snapshot(value: NativeSnapshot, expected: number): Promise<ClipboardSnapshot> {
    validateSnapshot(value);
    const files: NativeFile[] = [];
    for (const file of value.files) files.push(await readFile(file, expected));
    ensureCurrent(expected);
    return { ...(value.text === undefined ? {} : { text: value.text }), files };
  }
  async function exportFile(file: NativeFile, action: "copy" | "save" | "share"): Promise<boolean> {
    const expected = generation;
    ensureCurrent(expected);
    ContentSchema.parse({ kind: "attachment", name: file.name, contentType: file.contentType, size: file.bytes.byteLength });
    const { id } = await plugin.beginFile({ name: file.name, contentType: file.contentType });
    try {
      ensureCurrent(expected);
      for (let offset = 0; offset < file.bytes.length; offset += CHUNK_BYTES) {
        await plugin.appendFile({ id, base64: encodeChunk(file.bytes.subarray(offset, offset + CHUNK_BYTES)) });
        ensureCurrent(expected);
      }
      const result = await plugin.finishFile({ id, action });
      ensureCurrent(expected);
      return result.saved;
    } finally { await plugin.discardFile({ id }).catch(() => {}); }
  }
  async function updateState(operation: () => Promise<unknown>): Promise<UpdateState> {
    const expected = generation;
    ensureCurrent(expected);
    const result = await operation();
    ensureCurrent(expected);
    return UpdateStateSchema.parse(result);
  }
  return {
    kind: "android", dispose,
    exchangeSession: async accessToken => { const expected = generation; ensureCurrent(expected); const value = await plugin.exchangeInstallationSession({ accessToken }); ensureCurrent(expected); return value; },
    openAccessPanel: async deviceId => { ensureCurrent(); await plugin.openAccessPanel({ deviceId: IdSchema.parse(deviceId) }); },
    invalidateTransfers: async () => { ensureCurrent(); generation++; controller.abort(); controller = new AbortController(); pending = undefined; await plugin.invalidateTransfers(); },
    activity: { get initialActive() { return active; }, subscribe: listener => subscribe(activityListeners, listener) },
    shareFile: file => exportFile(file, "share"),
    native: {
      getDevice: async () => { ensureCurrent(); return DeviceSchema.parse(await plugin.getDevice()); },
      getAccessToken: async (interactive = false) => {
        const expected = generation; ensureCurrent(expected);
        const result = await plugin.getAccessToken({ interactive });
        ensureCurrent(expected);
        if (typeof result.accessToken !== "string" || !result.accessToken) throw new Error("Sign in again to continue");
        return result.accessToken;
      },
      signOut: async (reviewedNativeIds = []) => {
        ensureCurrent(); generation++; controller.abort(); controller = new AbortController(); pending = undefined;
        await plugin.signOut({ reviewedNativeIds });
      },
      readClipboard: async () => { const expected = generation; ensureCurrent(expected); return snapshot(await plugin.readClipboard(), expected); },
      copyText: async text => { ensureCurrent(); validateText(text); await plugin.copyText({ text }); },
      copyFile: async file => { await exportFile(file, "copy"); },
      saveFile: file => exportFile(file, "save"),
      getPendingClipboardShares: () => {
        if (pending) return pending;
        const expected = generation;
        const operation = (async () => {
          ensureCurrent(expected);
          const { requests } = await plugin.getPendingShares();
          ensureCurrent(expected);
          if (!Array.isArray(requests)) throw new Error("Invalid shared inbox");
          const unique = new Map<string, NativeRequest>();
          let total = 0;
          for (const request of requests) {
            IdSchema.parse(request.id);
            if (!Number.isFinite(request.capturedAt) || request.capturedAt < 0) throw new Error("Invalid shared inbox");
            if (unique.has(request.id)) continue;
            total += validateSnapshot(request);
            if (total > INBOX_BYTES) throw new Error("Shared inbox exceeds the allowed size");
            unique.set(request.id, request);
          }
          const result: PendingClipboardShare[] = [];
          for (const request of unique.values()) result.push({ id: request.id, capturedAt: request.capturedAt, snapshot: await snapshot(request, expected) });
          return result;
        })();
        pending = operation;
        void operation.finally(() => { if (pending === operation) pending = undefined; }).catch(() => {});
        return operation;
      },
      acknowledgeClipboardShare: async id => { ensureCurrent(); await plugin.acknowledgeShare({ id: IdSchema.parse(id) }); },
      takeNavigation: async () => { ensureCurrent(); return navigation(await plugin.takeNavigation()); },
      onNavigate: listener => subscribe(navigationListeners, listener),
      onShareClipboard: listener => subscribe(shareListeners, listener),
      getUpdateState: () => updateState(() => plugin.getUpdateState()),
      checkForUpdates: () => updateState(() => plugin.checkForUpdates()),
      startUpdate: () => updateState(() => plugin.startUpdate()),
      installUpdate: async () => { const expected = generation; ensureCurrent(expected); await plugin.installUpdate(); ensureCurrent(expected); },
      onUpdateState: listener => subscribe(updateListeners, listener),
    },
  };
}
