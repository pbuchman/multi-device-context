import { beforeEach, expect, it, vi } from "vitest";
const fakes = vi.hoisted(() => ({
  close: vi.fn(async () => {}), listen: vi.fn(async () => {}), addHook: vi.fn(),
  guard: { run: vi.fn() }, deviceIo: undefined as unknown,
  startCleanup: vi.fn(async () => {}), fatal: false, onFatal: undefined as (() => void) | undefined,
}));
vi.mock("firebase-admin/app", () => ({ applicationDefault() {}, initializeApp() { return {}; }, deleteApp: vi.fn(async () => {}) }));
vi.mock("firebase-admin/auth", () => ({ getAuth() { return {}; } }));
vi.mock("firebase-admin/firestore", () => ({ getFirestore() { return {}; } }));
vi.mock("firebase-admin/storage", () => ({ getStorage() { return { bucket() { return {}; } }; } }));
vi.mock("./config.js", () => ({ readServerConfig() { return { publicConfig: { appOrigin: "https://example.test", firebase: { projectId: "demo-mdc", storageBucket: "demo-mdc" } }, host: "127.0.0.1", port: 0 }; } }));
vi.mock("./auth.js", () => ({ createAuthVerifier() { return vi.fn(); } }));
vi.mock("./server.js", () => ({ buildServer() { return { close: fakes.close, listen: fakes.listen, addHook: fakes.addHook, server: { closeAllConnections() {}, closeIdleConnections() {} } }; } }));
vi.mock("./firebase.js", () => ({ FirebaseBackend: class {
  constructor(options: { onFatal: () => void }) { fakes.onFatal = options.onFatal; }
  get dependencyGuard() { return fakes.guard; }
  startCleanup() { return fakes.startCleanup(); }
  isFatal() { return fakes.fatal; }
} }));
vi.mock("./agent-store.js", () => ({ AgentStore: class {} }));
vi.mock("./access.js", () => ({ FirestoreAccessAdministration: class {} }));
vi.mock("./attachments.js", () => ({ AttachmentStore: class {} }));
vi.mock("./device-access.js", () => ({ DeviceAccessStore: class { constructor(_db: unknown, _auth: unknown, io: unknown) { fakes.deviceIo = io; } } }));
vi.mock("./context-origins.js", () => ({ ContextOriginsStore: class {} }));
vi.mock("./settings.js", () => ({ AccountSettings: class {} }));
vi.mock("./titles.js", () => ({ TitleWorker: class { start() {} async close() {} } }));
import { startServer } from "./index.js";
import { RecoveryLifecycle } from "./lifecycle.js";
beforeEach(() => { vi.clearAllMocks(); fakes.fatal = false; fakes.deviceIo = undefined; fakes.startCleanup.mockResolvedValue(); fakes.listen.mockResolvedValue(); });
it("wires startup watchdog recovery before listen and requests only one server close", async () => {
  const exit = vi.fn(), lifecycle = new RecoveryLifecycle({ exit });
  fakes.startCleanup.mockImplementationOnce(async () => { fakes.fatal = true; fakes.onFatal?.(); });
  await expect(startServer({}, lifecycle)).rejects.toMatchObject({ statusCode: 503 });
  expect(fakes.listen).not.toHaveBeenCalled();
  expect(fakes.deviceIo).toBe(fakes.guard);
  expect(fakes.close).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledExactlyOnceWith(75);
});
it("closes once on ordinary listen failure without the watchdog recovery exit", async () => {
  const exit = vi.fn(), lifecycle = new RecoveryLifecycle({ exit });
  fakes.listen.mockRejectedValueOnce(new Error("listen failed"));
  await expect(startServer({}, lifecycle)).rejects.toThrow("listen failed");
  expect(fakes.close).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
