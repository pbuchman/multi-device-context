// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "./platform.js";
const sdk = vi.hoisted(() => ({
  createAuth0Client: vi.fn(), initializeApp: vi.fn(() => ({ name: "test" })), deleteApp: vi.fn(async () => {}),
  initializeAuth: vi.fn(() => ({ persistence: "memory" })), getAuth: vi.fn(() => ({ persistence: "browser" })),
  signInWithCustomToken: vi.fn(async () => ({ user: { uid: "uid", email: "user@example.test" } })),
  signOut: vi.fn(async () => {}), terminate: vi.fn(async () => {}), clear: vi.fn(async () => {}),
}));
vi.mock("@auth0/auth0-spa-js", () => ({ createAuth0Client: sdk.createAuth0Client }));
vi.mock("firebase/app", () => ({ initializeApp: sdk.initializeApp, deleteApp: sdk.deleteApp }));
vi.mock("firebase/auth", () => ({ initializeAuth: sdk.initializeAuth, getAuth: sdk.getAuth, signInWithCustomToken: sdk.signInWithCustomToken, signOut: sdk.signOut, inMemoryPersistence: "in-memory" }));
vi.mock("firebase/firestore", () => ({ getFirestore: () => ({}), terminate: sdk.terminate, clearIndexedDbPersistence: sdk.clear }));
import { SessionManager } from "./auth.js";

const config = { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo.firebaseapp.com", projectId: "demo", storageBucket: "demo" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 };
afterEach(() => { vi.clearAllMocks(); });
function fixture(kind: "android" | "desktop" = "android") {
  const native = { getAccessToken: vi.fn(async () => "access"), signOut: vi.fn(async () => {}) };
  const platform = { kind, native, dispose: vi.fn() } as unknown as PlatformAdapter;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/api/session") ? { uid: "uid", customToken: "custom" } : config)));
  const manager = new SessionManager(fetcher, { platformFactory: async () => platform, mobile: kind === "android", appOrigin: config.appOrigin });
  return { manager, native, platform, fetcher };
}
it("restores Android through native auth and uses Firebase memory persistence", async () => {
  const f = fixture();
  const session = await f.manager.restore();
  expect(session?.platform).toBe(f.platform);
  expect(session?.bridge).toBeUndefined();
  expect(f.native.getAccessToken).toHaveBeenCalledWith(false);
  expect(sdk.createAuth0Client).not.toHaveBeenCalled();
  expect(sdk.initializeAuth).toHaveBeenCalledWith(expect.anything(), { persistence: "in-memory" });
  await session!.accessToken();
  await session!.signOut();
  expect(f.native.signOut).toHaveBeenCalledTimes(1);
  expect(sdk.signOut).toHaveBeenCalledTimes(1);
  await expect(session!.accessToken()).rejects.toThrow("expired");
});
it("retains desktop bridge and its existing Firebase initialization", async () => {
  const f = fixture("desktop");
  const session = await f.manager.login();
  expect(session?.bridge).toBe(f.native);
  expect(sdk.initializeAuth).not.toHaveBeenCalled();
  expect(sdk.getAuth).toHaveBeenCalled();
  expect(f.native.getAccessToken).toHaveBeenCalledWith(true);
});
it("coalesces concurrent restoration and disposes a mismatched Firebase identity", async () => {
  const f = fixture();
  const [one, two] = await Promise.all([f.manager.restore(), f.manager.restore()]);
  expect(one).toBe(two);
  expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
  await one!.signOut();
  sdk.signInWithCustomToken.mockResolvedValueOnce({ user: { uid: "wrong", email: "other@example.test" } });
  await expect(f.manager.login()).rejects.toThrow("mismatch");
  expect(sdk.deleteApp).toHaveBeenCalledTimes(2);
});

it("rejects a late token after logout and uses one logout operation", async () => {
  const f = fixture();
  const session = (await f.manager.login())!;
  let resolve!: (token: string) => void;
  f.native.getAccessToken.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const token = session.accessToken();
  const rejected = expect(token).rejects.toThrow("expired");
  await Promise.all([session.signOut(), session.signOut()]);
  resolve("old"); await rejected;
  expect(f.native.signOut).toHaveBeenCalledTimes(1);
});

it("disposes Firebase when custom-token sign-in fails", async () => {
  const f = fixture();
  sdk.signInWithCustomToken.mockRejectedValueOnce(new Error("network"));
  await expect(f.manager.login()).rejects.toThrow("network");
  expect(sdk.deleteApp).toHaveBeenCalledTimes(1);
});

it("cleans Firebase if the browser profile lookup fails after authentication", async () => {
  const f = fixture();
  sdk.createAuth0Client.mockResolvedValueOnce({ isAuthenticated: async () => true, getTokenSilently: async () => "access", getUser: async () => { throw new Error("profile unavailable"); } });
  const manager = new SessionManager(f.fetcher, { platformFactory: async () => ({ kind: "browser", dispose() {} }) });
  await expect(manager.login()).rejects.toThrow("profile unavailable");
  expect(sdk.deleteApp).toHaveBeenCalledTimes(1);
});

it("invalidates native auth before web cleanup and leaves web data untouched on auth failure", async () => {
  const f = fixture(); const session = (await f.manager.login())!;
  const cleanup = vi.fn(async () => {});
  f.native.signOut.mockRejectedValueOnce(new Error("partial native failure"));
  await expect(session.signOut(cleanup)).rejects.toThrow("partial native failure");
  expect(cleanup).not.toHaveBeenCalled();
  await expect(session.accessToken()).rejects.toThrow("expired");
  await session.signOut(cleanup);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("retries failed cleanup without repeating successful native sign-out", async () => {
  const f = fixture(); const session = (await f.manager.login())!;
  const cleanup = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
  await expect(session.signOut(cleanup)).rejects.toThrow("disk unavailable");
  await session.signOut(cleanup);
  expect(f.native.signOut).toHaveBeenCalledOnce(); expect(sdk.deleteApp).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it("passes only explicitly reviewed native IDs and allows reconfirmation after a native race", async () => {
  const f = fixture("desktop"), session = (await f.manager.login())!, cleanup = vi.fn(async () => {});
  f.native.signOut.mockRejectedValueOnce(new Error("Inbox changed"));
  await expect(session.signOut(cleanup, ["reviewed"])).rejects.toThrow("changed");
  expect(cleanup).not.toHaveBeenCalled();
  await session.signOut(cleanup, ["reviewed", "new"]);
  expect(f.native.signOut.mock.calls).toEqual([[["reviewed"]], [["reviewed", "new"]]]);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("leaves a legacy desktop session usable when reviewed sign-out is unsupported", async () => {
  const f = fixture("desktop"), session = (await f.manager.login())!;
  f.platform.assertCanSignOut = () => { throw new Error("Update this desktop app"); };
  const cleanup = vi.fn();
  await expect(session.signOut(cleanup, [])).rejects.toThrow("Update this desktop app");
  expect(f.native.signOut).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
  expect(await session.accessToken()).toBe("access"); expect(await f.manager.restore()).toBe(session);
});

it("captures browser logout navigation and purges only after local auth logout succeeds", async () => {
  const events: string[] = [];
  const logout = vi.fn(async (options: { openUrl: (url: string) => Promise<void> }) => { events.push("auth0"); await options.openUrl("https://login.example.test/logout"); });
  sdk.createAuth0Client.mockResolvedValueOnce({ isAuthenticated: async () => true, getTokenSilently: async () => "access", getUser: async () => ({ name: "User" }), logout });
  const f = fixture(); const navigate = vi.fn((url: string) => { events.push("navigate"); expect(url).toBe("https://login.example.test/logout"); });
  const manager = new SessionManager(f.fetcher, { platformFactory: async () => ({ kind: "browser", dispose() {} }), navigateAfterSignOut: navigate });
  const session = (await manager.login())!;
  await session.signOut(async () => { events.push("cleanup"); });
  expect(events).toEqual(["auth0", "cleanup", "navigate"]);
  expect(logout).toHaveBeenCalledWith(expect.objectContaining({ openUrl: expect.any(Function) }));
});

it("does not purge or navigate if browser local logout fails, and blocks the old token", async () => {
  const logout = vi.fn().mockRejectedValueOnce(new Error("cache unavailable"));
  sdk.createAuth0Client.mockResolvedValueOnce({ isAuthenticated: async () => true, getTokenSilently: async () => "access", getUser: async () => ({}), logout });
  const f = fixture(), navigate = vi.fn(), cleanup = vi.fn();
  const manager = new SessionManager(f.fetcher, { platformFactory: async () => ({ kind: "browser", dispose() {} }), navigateAfterSignOut: navigate });
  const session = (await manager.login())!;
  await expect(session.signOut(cleanup)).rejects.toThrow("cache unavailable");
  expect(cleanup).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  await expect(session.accessToken()).rejects.toThrow("expired");
});

it("does not repeat account cleanup after browser navigation fails", async () => {
  const logout = vi.fn(async (options: { openUrl: (url: string) => Promise<void> }) => { await options.openUrl("https://login.example.test/logout"); });
  sdk.createAuth0Client.mockResolvedValueOnce({ isAuthenticated: async () => true, getTokenSilently: async () => "access", getUser: async () => ({}), logout });
  const f = fixture(), navigate = vi.fn().mockImplementationOnce(() => { throw new Error("navigation blocked"); }), cleanup = vi.fn(async () => {});
  const manager = new SessionManager(f.fetcher, { platformFactory: async () => ({ kind: "browser", dispose() {} }), navigateAfterSignOut: navigate });
  const session = (await manager.login())!;
  await expect(session.signOut(cleanup)).rejects.toThrow("navigation blocked");
  await session.signOut(cleanup);
  expect(logout).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledTimes(2);
});
