// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth0Client } from "@auth0/auth0-spa-js";
import type { RuntimeConfig } from "@mdc/contracts";
import { BrowserIdentity, isAccessPageRequest, safeAccessPath } from "./browser-identity.js";
const config: RuntimeConfig = { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo.firebaseapp.com", projectId: "demo", storageBucket: "demo" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 };
const target = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { window.history.replaceState({}, "", "/access"); sessionStorage.clear(); });
describe("browser-only access identity", () => {
  it("accepts only the fixed access route with an optional valid public device ID", () => {
    expect(safeAccessPath(`/access?device=${target}`)).toBe(`/access?device=${target}`);
    for (const path of ["https://evil.test/access", "//evil.test/access", "/access?token=secret", "/access?device=bad", "/access#token", "/access/other"]) expect(safeAccessPath(path)).toBeUndefined();
  });
  it("preserves the target across Auth0 redirect without a Firebase exchange", async () => {
    window.history.replaceState({}, "", `/access?device=${target}`);
    const sdk = { isAuthenticated: vi.fn(async () => false), loginWithRedirect: vi.fn(async () => {}), handleRedirectCallback: vi.fn(async () => ({ appState: { returnTo: `/access?device=${target}` } })) };
    const identity = new BrowserIdentity(config, async () => sdk as unknown as Auth0Client);
    expect(await identity.login()).toBe(false);
    expect(sdk.loginWithRedirect).toHaveBeenCalledWith(expect.objectContaining({ appState: { returnTo: `/access?device=${target}` } }));
    window.history.replaceState({}, "", "/auth/callback?code=code&state=state");
    expect(isAccessPageRequest()).toBe(true);
    const callback = new BrowserIdentity(config, async () => sdk as unknown as Auth0Client);
    await Promise.all([callback.prepare(), callback.prepare()]);
    expect(sdk.handleRedirectCallback).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search).toBe(`/access?device=${target}`);
    expect(sessionStorage.length).toBe(0);
  });
  it("does not route unrelated callbacks to the access page", () => {
    window.history.replaceState({}, "", "/auth/callback?code=code&state=state");
    expect(isAccessPageRequest()).toBe(false);
  });
});
