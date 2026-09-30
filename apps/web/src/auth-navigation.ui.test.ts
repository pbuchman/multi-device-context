// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ loginWithRedirect: vi.fn(), isAuthenticated: vi.fn(async () => false), handleRedirectCallback: vi.fn() }));
vi.mock("@auth0/auth0-spa-js", () => ({ createAuth0Client: async () => auth }));
import { SessionManager } from "./auth.js";
const config = { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo.firebaseapp.com", projectId: "demo", storageBucket: "demo" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 };
const target = "/contexts/00000000-0000-4000-8000-000000000001";
afterEach(() => { history.replaceState({}, "", "/"); vi.clearAllMocks(); });
it("preserves a context link through Google redirect", async () => {
  history.replaceState({}, "", target);
  const manager = new SessionManager(async () => new Response(JSON.stringify(config)));
  await manager.login();
  expect(auth.loginWithRedirect).toHaveBeenCalledWith(expect.objectContaining({ appState: { returnTo: target } }));
  history.replaceState({}, "", "/auth/callback?code=example&state=example");
  auth.handleRedirectCallback.mockResolvedValue({ appState: { returnTo: target } });
  await manager.prepare(); expect(location.pathname).toBe(target);
});
it("does not accept an external return URL", async () => {
  history.replaceState({}, "", "/auth/callback?code=example&state=example");
  auth.handleRedirectCallback.mockResolvedValue({ appState: { returnTo: "https://outside.example/" } });
  await new SessionManager(async () => new Response(JSON.stringify(config))).prepare();
  expect(location.pathname).toBe("/");
});
