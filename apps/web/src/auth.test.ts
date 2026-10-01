import { describe, expect, it, vi } from "vitest";

import { auth0ClientOptions, exchangeSession, loadRuntimeConfig, signOutSession } from "./auth.js";

const config = {
  appOrigin: "https://contexts.example.com",
  auth0: {
    domain: "login.example.com",
    audience: "https://contexts.example.com/api",
    webClientId: "web-client",
    nativeClientId: "native-client",
    connection: "google-oauth2" as const,
  },
  firebase: {
    apiKey: "api-key",
    authDomain: "contexts.firebaseapp.com",
    projectId: "contexts",
    storageBucket: "contexts.firebasestorage.app",
  },
  limits: { maxTextBytes: 262144 as const, maxAttachmentBytes: 104857600 as const },
  bridgeVersion: 1 as const,
};

describe("authentication boundary", () => {
  it("uses Auth0 memory tokens and the Google-only connection", () => {
    expect(auth0ClientOptions(config)).toMatchObject({
      domain: "login.example.com",
      clientId: "web-client",
      cacheLocation: "memory",
      useRefreshTokens: false,
      authorizationParams: {
        audience: "https://contexts.example.com/api",
        connection: "google-oauth2",
        redirect_uri: "https://contexts.example.com/auth/callback",
      },
    });
  });

  it("rejects malformed runtime configuration", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...config, bridgeVersion: 2 })));
    await expect(loadRuntimeConfig(fetcher)).rejects.toThrow("configuration");
  });

  it("loads mobile config from the trusted server and rejects native build configuration drift", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(config)));
    await expect(loadRuntimeConfig(fetcher, { mobile: true, appOrigin: config.appOrigin })).resolves.toEqual(config);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["/mobile-config.json", `${config.appOrigin}/api/config`]);
    const changed = { ...config, auth0: { ...config.auth0, nativeClientId: "different-client" } };
    const drift = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(config))).mockResolvedValueOnce(new Response(JSON.stringify(changed)));
    await expect(loadRuntimeConfig(drift, { mobile: true, appOrigin: config.appOrigin })).rejects.toThrow("Android app");
  });

  it("rejects mobile config missing a trusted HTTPS origin before making a request", async () => {
    const fetcher = vi.fn();
    await expect(loadRuntimeConfig(fetcher, { mobile: true })).rejects.toThrow("origin");
    await expect(loadRuntimeConfig(fetcher, { mobile: true, appOrigin: "https://elsewhere.test" })).rejects.toThrow();
  });

  it("posts browser installation proof through the same-origin cookie and validates the verified device", async () => {
    const device = { id: "11111111-1111-4111-8111-111111111111", name: "Browser", platform: "browser", mode: "own", version: 1, createdAt: 1, updatedAt: 1 };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ uid: "derived_uid", customToken: "custom", device }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(exchangeSession("access-token", fetcher)).resolves.toEqual({ uid: "derived_uid", customToken: "custom", device });
    expect(fetcher).toHaveBeenCalledWith("/api/session", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer access-token", "content-type": "application/json" }, credentials: "same-origin", body: "{}",
    }));
  });

  it("allows native cancellation before destructive Firebase disposal", async () => {
    const events: string[] = [];
    const native = vi.fn(async () => { events.push("native"); throw new Error("cancelled"); });
    const dispose = vi.fn(async () => { events.push("dispose"); });
    await expect(signOutSession(native, dispose)).rejects.toThrow("cancelled");
    expect(events).toEqual(["native"]);
  });
});

it("enrolls a missing browser installation once but never reenrolls rejected proof", async () => {
 const device = { id: "11111111-1111-4111-8111-111111111111", name: "Browser", platform: "browser", mode: "own", version: 1, createdAt: 1, updatedAt: 1 };
 const fetcher=vi.fn().mockResolvedValueOnce(new Response("{}",{status:428})).mockResolvedValueOnce(new Response("{}"))
 .mockResolvedValueOnce(new Response(JSON.stringify({uid:"uid",customToken:"custom",device})));
 expect((await exchangeSession("auth0",fetcher)).device).toEqual(device); expect(fetcher).toHaveBeenCalledTimes(3);
 const rejected=vi.fn(async()=>new Response("{}",{status:403})); await expect(exchangeSession("auth0",rejected)).rejects.toThrow(/installation/); expect(rejected).toHaveBeenCalledOnce();
});
