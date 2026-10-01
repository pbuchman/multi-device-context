import { expect, it, vi } from "vitest";
import { createAndroidAdapter, type AndroidDependencies, type MdcNativePlugin } from "./android.js";

const id = "00000000-0000-4000-8000-000000000001";
function fixture(overrides: Partial<MdcNativePlugin> = {}) {
  const handles: Array<{ remove: ReturnType<typeof vi.fn> }> = [];
  const callbacks = new Map<string, (event: any) => void>();
  const addListener = vi.fn(async (name: string, callback: (event: any) => void) => {
    callbacks.set(name, callback);
    const handle = { remove: vi.fn(async () => {}) }; handles.push(handle); return handle;
  });
  const plugin = {
    getDevice: vi.fn(async () => ({ id, name: "Phone" })),
    getAccessToken: vi.fn(async () => ({ accessToken: "access" })), signOut: vi.fn(async () => {}),
    readClipboard: vi.fn(async () => ({ text: "clipboard", files: [] })), copyText: vi.fn(async () => {}),
    beginFile: vi.fn(async () => ({ id: "staged" })), appendFile: vi.fn(async () => {}),
    finishFile: vi.fn(async () => ({ saved: true })), discardFile: vi.fn(async () => {}),
    getPendingShares: vi.fn(async () => ({ requests: [] })), acknowledgeShare: vi.fn(async () => {}),
    takeNavigation: vi.fn(async () => ({})), addListener, ...overrides,
  } as MdcNativePlugin;
  const dependencies: AndroidDependencies = {
    plugin, app: { getState: async () => ({ isActive: true }), addListener },
    convertFileSrc: path => `https://localhost/_capacitor_file_${path.slice(7)}`,
    fetcher: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  };
  return { plugin, dependencies, callbacks, handles };
}

it("sends files in bounded chunks and cleans staging when the chooser cancels", async () => {
  const f = fixture({ finishFile: vi.fn(async () => ({ saved: false })) });
  const adapter = await createAndroidAdapter(f.dependencies);
  const bytes = new Uint8Array(256 * 1024 + 3).fill(42);
  expect(await adapter.shareFile!({ name: "sample.bin", contentType: "application/octet-stream", bytes })).toBe(false);
  const chunks = vi.mocked(f.plugin.appendFile).mock.calls.map(([value]) => atob(value.base64));
  expect(chunks.map(value => value.length)).toEqual([256 * 1024, 3]);
  expect(chunks.join("")).toBe(String.fromCharCode(42).repeat(bytes.length));
  expect(f.plugin.discardFile).toHaveBeenCalledWith({ id: "staged" });
  adapter.dispose();
});

it("discards staging after a failed append and rejects oversized files before staging", async () => {
  const f = fixture({ appendFile: vi.fn(async () => { throw new Error("full"); }) });
  const adapter = await createAndroidAdapter(f.dependencies);
  await expect(adapter.native!.saveFile({ name: "a", contentType: "text/plain", bytes: new Uint8Array([1]) })).rejects.toThrow("full");
  expect(f.plugin.discardFile).toHaveBeenCalledWith({ id: "staged" });
  vi.mocked(f.plugin.beginFile).mockClear();
  await expect(adapter.native!.saveFile({ name: "a", contentType: "text/plain", bytes: new Uint8Array(104857601) })).rejects.toThrow();
  expect(f.plugin.beginFile).not.toHaveBeenCalled();
  adapter.dispose();
});

it("deduplicates incoming requests, reads private files and leaves acknowledgement to durable storage", async () => {
  const request = { id, capturedAt: 1, text: "shared", files: [{ id: "file", name: "a", contentType: "text/plain", size: 3, path: "file:///data/user/0/app/files/inbox/a" }] };
  const f = fixture({ getPendingShares: vi.fn(async () => ({ requests: [request, request] })) });
  const adapter = await createAndroidAdapter(f.dependencies);
  const [one, two] = await Promise.all([adapter.native!.getPendingClipboardShares(), adapter.native!.getPendingClipboardShares()]);
  expect(one).toEqual([{ id, capturedAt: 1, snapshot: { text: "shared", files: [{ name: "a", contentType: "text/plain", bytes: new Uint8Array([1, 2, 3]) }] } }]);
  expect(two).toEqual(one);
  expect(f.plugin.getPendingShares).toHaveBeenCalledTimes(1);
  expect(f.dependencies.fetcher).toHaveBeenCalledTimes(1);
  expect(f.plugin.acknowledgeShare).not.toHaveBeenCalled();
  await adapter.native!.acknowledgeClipboardShare(id);
  expect(f.plugin.acknowledgeShare).toHaveBeenCalledWith({ id });
  adapter.dispose();
});

it("rejects remote staged paths and byte length mismatches", async () => {
  const file = { id: "file", name: "a", contentType: "text/plain", size: 2, path: "https://outside.test/file" };
  const f = fixture({ readClipboard: vi.fn(async () => ({ files: [file] })) });
  const adapter = await createAndroidAdapter(f.dependencies);
  await expect(adapter.native!.readClipboard()).rejects.toThrow();
  expect(f.dependencies.fetcher).not.toHaveBeenCalled();
  file.path = "file:///data/user/0/app/files/inbox/a";
  await expect(adapter.native!.readClipboard()).rejects.toThrow("size");
  adapter.dispose();
});

it("tracks current activity, sanitizes navigation, and removes all event listeners on disposal", async () => {
  const f = fixture();
  const adapter = await createAndroidAdapter(f.dependencies);
  const activity = vi.fn(); const share = vi.fn(); const navigate = vi.fn();
  const stop = adapter.activity!.subscribe(activity);
  adapter.native!.onShareClipboard(share); adapter.native!.onNavigate!(navigate);
  f.callbacks.get("appStateChange")!({ isActive: false });
  expect(adapter.activity!.initialActive).toBe(false);
  expect(activity).toHaveBeenCalledWith(false);
  f.callbacks.get("shareReceived")!({}); expect(share).toHaveBeenCalledTimes(1);
  f.callbacks.get("navigate")!({ contextId: "invalid" }); expect(navigate).not.toHaveBeenCalled();
  f.callbacks.get("navigate")!({ contextId: id }); expect(navigate).toHaveBeenCalledWith({ contextId: id });
  stop(); adapter.dispose(); adapter.dispose();
  f.callbacks.get("shareReceived")!({}); expect(share).toHaveBeenCalledTimes(1);
  expect(f.handles).toHaveLength(3);
  for (const handle of f.handles) expect(handle.remove).toHaveBeenCalledTimes(1);
});

it("cancels a late token result after sign-out and ignores empty navigation", async () => {
  let resolve!: (value: { accessToken: string }) => void;
  const f = fixture({ getAccessToken: vi.fn(() => new Promise<{ accessToken: string }>(done => { resolve = done; })) });
  const adapter = await createAndroidAdapter(f.dependencies);
  const token = adapter.native!.getAccessToken(true);
  const rejected = expect(token).rejects.toThrow("cancelled");
  await adapter.native!.signOut(); resolve({ accessToken: "old" }); await rejected;
  await expect(adapter.native!.takeNavigation!()).resolves.toBeUndefined();
  adapter.dispose();
});

it("rejects an entire oversized share before reading any staged file", async () => {
  const files = [1, 2].map(index => ({ id: `${index}`, name: "large", contentType: "application/octet-stream", size: 60 * 1024 * 1024, path: `file:///private/${index}` }));
  const f = fixture({ getPendingShares: vi.fn(async () => ({ requests: [{ id, capturedAt: 1, files }] })) });
  const adapter = await createAndroidAdapter(f.dependencies);
  await expect(adapter.native!.getPendingClipboardShares()).rejects.toThrow("size");
  expect(f.dependencies.fetcher).not.toHaveBeenCalled();
  adapter.dispose();
});

it("cleans already registered listeners if plugin initialization fails", async () => {
  const f = fixture({ addListener: vi.fn(async () => { throw new Error("plugin unavailable"); }) });
  await expect(createAndroidAdapter(f.dependencies)).rejects.toThrow("plugin unavailable");
  expect(f.handles).toHaveLength(1);
  expect(f.handles[0]!.remove).toHaveBeenCalledTimes(1);
});
