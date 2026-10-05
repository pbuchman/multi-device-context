import type { RuntimeConfig } from "@mdc/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readServerConfig } from "./config.js";
import type { DeviceAccessPort } from "./device-access.js";
import {
  BackendConflictError,
  BackendNotFoundError,
  buildServer,
  type Backend,
} from "./server.js";

const CONTEXT_ID = "00000000-0000-4000-8000-000000000001";
const ITEM_ID = "00000000-0000-4000-8000-000000000002";

const publicConfig: RuntimeConfig = {
  appOrigin: "https://app.example.test",
  auth0: {
    domain: "login.example.test",
    audience: "https://api.example.test",
    webClientId: "web-client",
    nativeClientId: "native-client",
    connection: "google-oauth2",
  },
  firebase: {
    apiKey: "public-api-key",
    authDomain: "demo-mdc.firebaseapp.com",
    projectId: "demo-mdc",
    storageBucket: "demo-mdc.firebasestorage.app",
  },
  limits: { maxTextBytes: 262_144, maxAttachmentBytes: 104_857_600 },
  bridgeVersion: 1,
};

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    createCustomToken: vi.fn(async (uid) => `custom:${uid}`),
    completeUpload: vi.fn(async () => undefined),
    deleteContext: vi.fn(async () => undefined),
    deleteItem: vi.fn(async () => undefined),
    checkReady: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

const verifier = vi.fn(async (token: string) => {
  if (token !== "valid-token") throw new Error("Unauthorized");
  return { uid: "derived_uid", subject: "google-oauth2|person-123" };
});

const TEST_DEVICE_ID = "00000000-0000-4000-8000-000000000010";
const testDevice = { id: TEST_DEVICE_ID, name: "Test", platform: "android" as const, mode: "all" as const, version: 1, createdAt: 1, updatedAt: 1 };
const devices: DeviceAccessPort = {
  enroll: async () => ({ device: testDevice, credential: "a".repeat(43) }),
  exchange: async (_uid, id, credential) => { if (id !== TEST_DEVICE_ID || credential !== "a".repeat(43)) throw new Error(); return testDevice; },
  authenticate: async token => { if (token !== "valid-token") throw new Error(); return { uid: "derived_uid", device: testDevice }; },
};

const openServers: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.clearAllMocks();
});

function server(fake = backend()) {
  const app = buildServer({ publicConfig, verifier, devices, backend: fake });
  openServers.push(app);
  return { app, fake };
}

describe("readServerConfig", () => {
  it("projects only explicit public values and applies private defaults", () => {
    const result = readServerConfig({
      MDC_APP_ORIGIN: publicConfig.appOrigin,
      MDC_AUTH0_DOMAIN: publicConfig.auth0.domain,
      MDC_AUTH0_AUDIENCE: publicConfig.auth0.audience,
      MDC_AUTH0_WEB_CLIENT_ID: publicConfig.auth0.webClientId,
      MDC_AUTH0_NATIVE_CLIENT_ID: publicConfig.auth0.nativeClientId,
      MDC_FIREBASE_API_KEY: publicConfig.firebase.apiKey,
      MDC_FIREBASE_AUTH_DOMAIN: publicConfig.firebase.authDomain,
      MDC_GCP_PROJECT_ID: publicConfig.firebase.projectId,
      MDC_STORAGE_BUCKET: publicConfig.firebase.storageBucket,
      MDC_PRIVATE_SECRET: "must-not-leak",
    });
    expect(result.publicConfig).toEqual(publicConfig);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(3000);
  });

  it("reports missing names and invalid port without exposing values", () => {
    expect(() => readServerConfig({ MDC_PORT: "secret-invalid-port" })).toThrow(
      /MDC_APP_ORIGIN.*MDC_AUTH0_DOMAIN/,
    );
    expect(() =>
      readServerConfig({
        MDC_APP_ORIGIN: publicConfig.appOrigin,
        MDC_AUTH0_DOMAIN: publicConfig.auth0.domain,
        MDC_AUTH0_AUDIENCE: publicConfig.auth0.audience,
        MDC_AUTH0_WEB_CLIENT_ID: publicConfig.auth0.webClientId,
        MDC_AUTH0_NATIVE_CLIENT_ID: publicConfig.auth0.nativeClientId,
        MDC_FIREBASE_API_KEY: publicConfig.firebase.apiKey,
        MDC_FIREBASE_AUTH_DOMAIN: publicConfig.firebase.authDomain,
        MDC_GCP_PROJECT_ID: publicConfig.firebase.projectId,
        MDC_STORAGE_BUCKET: publicConfig.firebase.storageBucket,
        MDC_PORT: "secret-invalid-port",
      }),
    ).toThrow("MDC_PORT");
  });
});

describe("public and health routes", () => {
  it("returns only public runtime config with no-store caching and security headers", async () => {
    const { app } = server();
    const response = await app.inject({ method: "GET", url: "/api/config" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(publicConfig);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect(response.headers["content-security-policy"]).toContain("media-src 'self' blob:");
    expect(response.headers["content-security-policy"]).toContain("frame-src https://login.example.test");
    expect(response.headers["content-security-policy"]).toContain("worker-src 'self' blob:");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("distinguishes liveness and sanitized readiness failures", async () => {
    const fake = backend({ checkReady: vi.fn(async () => Promise.reject(new Error("secret"))) });
    const { app } = server(fake);
    expect((await app.inject({ method: "GET", url: "/health/live" })).json()).toEqual({ status: "ok" });
    const readiness = await app.inject({ method: "GET", url: "/health/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({ status: "unavailable" });
    expect(readiness.body).not.toContain("secret");
  });

  it("returns sanitized JSON for unknown API routes", async () => {
    const { app } = server();
    const response = await app.inject({ method: "GET", url: "/api/unknown?secret=value" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found" });
    expect(response.body).not.toContain("secret");
    const apiRoot = await app.inject({ method: "GET", url: "/api" });
    expect(apiRoot.statusCode).toBe(404);
    expect(apiRoot.json()).toEqual({ error: "Not Found" });
  });

  it("does not echo parser exceptions from malformed requests", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Bad Request" });
  });
});

describe("authenticated API", () => {
  it.each([
    ["missing", undefined],
    ["wrong scheme", "Basic valid-token"],
    ["invalid", "Bearer invalid-token"],
    ["multiple", "Bearer valid-token extra"],
  ])("rejects %s authorization", async (_name, authorization) => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: authorization ? { authorization } : {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
  });

  it("exchanges the verified subject-derived UID and rejects UID override fields", async () => {
    const fake = backend();
    const { app } = server(fake);
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { authorization: "Bearer valid-token" },
      payload: { deviceId: TEST_DEVICE_ID, credential: "a".repeat(43) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ uid: "derived_uid", customToken: "custom:derived_uid", device: testDevice });
    expect(fake.createCustomToken).toHaveBeenCalledWith("derived_uid", TEST_DEVICE_ID);
    expect(response.headers["cache-control"]).toBe("no-store");

    const override = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      payload: { uid: "attacker" },
    });
    expect(override.statusCode).toBe(400);
    expect(fake.createCustomToken).toHaveBeenCalledTimes(1);
  });

  it("uses the authenticated namespace for completion and both deletions", async () => {
    const fake = backend();
    const { app } = server(fake);
    const headers = { authorization: "Bearer valid-token" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/contexts/${CONTEXT_ID}/items/${ITEM_ID}/complete`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/contexts/${CONTEXT_ID}`, headers })).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/contexts/${CONTEXT_ID}/items/${ITEM_ID}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(fake.completeUpload).toHaveBeenCalledWith("derived_uid", CONTEXT_ID, ITEM_ID, { uid: "derived_uid", deviceId: TEST_DEVICE_ID });
    expect(fake.deleteContext).toHaveBeenCalledWith("derived_uid", CONTEXT_ID, { uid: "derived_uid", deviceId: TEST_DEVICE_ID });
    expect(fake.deleteItem).toHaveBeenCalledWith("derived_uid", CONTEXT_ID, ITEM_ID, { uid: "derived_uid", deviceId: TEST_DEVICE_ID });
  });

  it.each([
    `/api/contexts/not-a-uuid`,
    `/api/contexts/${CONTEXT_ID}/items/not-a-uuid`,
    `/api/contexts/${CONTEXT_ID}/items/not-a-uuid/complete`,
  ])("rejects invalid IDs in %s", async (url) => {
    const { app, fake } = server();
    const response = await app.inject({
      method: url.endsWith("complete") ? "POST" : "DELETE",
      url,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(response.statusCode).toBe(400);
    expect(fake.deleteContext).not.toHaveBeenCalled();
    expect(fake.deleteItem).not.toHaveBeenCalled();
    expect(fake.completeUpload).not.toHaveBeenCalled();
  });

  it("maps upload absence to 404, conflicts to 409, and hides backend errors", async () => {
    for (const [error, status] of [
      [new BackendNotFoundError(), 404],
      [new BackendConflictError(), 409],
      [new Error("sensitive backend detail"), 500],
    ] as const) {
      const fake = backend({ completeUpload: vi.fn(async () => Promise.reject(error)) });
      const { app } = server(fake);
      const response = await app.inject({
        method: "POST",
        url: `/api/contexts/${CONTEXT_ID}/items/${ITEM_ID}/complete`,
        headers: { authorization: "Bearer valid-token" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("sensitive");
    }
  });

  it("keeps repeated successful deletion idempotent", async () => {
    const fake = backend();
    const { app } = server(fake);
    const request = {
      method: "DELETE" as const,
      url: `/api/contexts/${CONTEXT_ID}`,
      headers: { authorization: "Bearer valid-token" },
    };
    expect((await app.inject(request)).statusCode).toBe(204);
    expect((await app.inject(request)).statusCode).toBe(204);
    expect(fake.deleteContext).toHaveBeenCalledTimes(2);
  });
});

describe("review security boundaries", () => {
  it("R7: blocks current, historical and missing source map URLs before SPA fallback", async () => {
    const { app } = server();
    for (const url of ["/assets/index.js.map", "/old.js.map?cache=bypass", "/test.MAP"]) {
      const response = await app.inject({ url }); expect(response.statusCode).toBe(404); expect(response.headers["content-type"]).toContain("application/json");
    }
  });
  it("R9: settings use the authenticated owner and reject agent tokens or UID overrides", async () => {
    const settings = { get: vi.fn(async () => ({ aiTitlesEnabled: false })), set: vi.fn(async (_uid: string, value: { aiTitlesEnabled: boolean }) => value) };
    const app = buildServer({ publicConfig, verifier, devices, backend: backend(), settings }); openServers.push(app);
    expect((await app.inject({ url: "/api/settings", headers: { authorization: "Bearer agent" } })).statusCode).toBe(401);
    const headers = { authorization: "Bearer valid-token" };
    const get = await app.inject({ url: "/api/settings", headers }); expect(get.json()).toEqual({ aiTitlesEnabled: false }); expect(settings.get).toHaveBeenCalledWith("derived_uid");
    expect((await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { aiTitlesEnabled: true, uid: "victim" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { aiTitlesEnabled: true } })).statusCode).toBe(200);
    expect(settings.set).toHaveBeenCalledWith("derived_uid", { aiTitlesEnabled: true }, { uid: "derived_uid", deviceId: TEST_DEVICE_ID });
  });
  it("R2: untrusted remote clients cannot bypass the IP limit with forwarded headers", async () => {
    const { app } = server();
    for (let i=0; i<65; i++) {
      const response = await app.inject({ url: "/api/unknown", remoteAddress: "192.0.2.1", headers: { "x-forwarded-for": `198.51.100.${i+1}` } });
      expect(response.statusCode).toBe(i < 60 ? 404 : 429);
    }
  });
});

describe('Android CORS', () => {
  it('answers allowed preflight without bypassing actual bearer validation', async () => {
    const { app } = server();
    const preflight = await app.inject({method:'OPTIONS',url:'/api/session',headers:{origin:'https://localhost','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    const actual = await app.inject({method:'POST',url:'/api/session',headers:{origin:'https://localhost'}});
    expect(actual.statusCode).toBe(401);
    expect(actual.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(actual.headers.vary).toContain('Origin');
  });
  it('does not authorize unrelated origins, methods or headers', async () => {
    const { app } = server();
    for(const headers of [
      {origin:'https://localhost.evil.test','access-control-request-method':'POST'},
      {origin:'https://localhost','access-control-request-method':'CONNECT'},
      {origin:'https://localhost','access-control-request-method':'POST','access-control-request-headers':'x-secret'},
    ]) {
      const response=await app.inject({method:'OPTIONS',url:'/api/session',headers});
      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe("Android deployed API integration", () => {
  it("permits native settings PATCH while retaining bearer and owner validation", async () => {
    const settings = { get: vi.fn(async () => ({ aiTitlesEnabled: false })), set: vi.fn(async (_uid: string, value: { aiTitlesEnabled: boolean }) => value) };
    const app = buildServer({ publicConfig, verifier, devices, backend: backend(), settings }); openServers.push(app);
    const headers = { origin: "https://localhost", "access-control-request-method": "PATCH", "access-control-request-headers": "authorization,content-type" };
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/settings", headers });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    const unauthorized = await app.inject({ method: "PATCH", url: "/api/settings", headers: { origin: "https://localhost" }, payload: { aiTitlesEnabled: true } });
    expect(unauthorized.statusCode).toBe(401);
    const actual = await app.inject({ method: "PATCH", url: "/api/settings", headers: { origin: "https://localhost", authorization: "Bearer valid-token" }, payload: { aiTitlesEnabled: true } });
    expect(actual.statusCode).toBe(200);
    expect(actual.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(settings.set).toHaveBeenCalledWith("derived_uid", { aiTitlesEnabled: true }, { uid: "derived_uid", deviceId: TEST_DEVICE_ID });
  });

  it("exposes rate-limit backoff to native clients and still limits preflights", async () => {
    const { app } = server();
    const headers = { origin: "https://localhost", "access-control-request-method": "POST" };
    for (let i = 0; i < 60; i++) expect((await app.inject({ method: "OPTIONS", url: "/api/session", headers })).statusCode).toBe(204);
    const response = await app.inject({ url: "/api/unknown", headers: { origin: "https://localhost" } });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(response.headers["access-control-expose-headers"]).toBe("Retry-After");
  });
});

describe("account profile", () => {
  it("requires verified auth and returns only matching profile fields without a device grant", async () => {
    const profileFetcher = vi.fn(async () => new Response(JSON.stringify({ sub: "google-oauth2|person-123", name: "Person", email: "person@example.test", picture: "private" })));
    const app = buildServer({ publicConfig, verifier, backend: backend(), profileFetcher }); openServers.push(app);
    expect((await app.inject({ method: "GET", url: "/api/profile" })).statusCode).toBe(401);
    expect(profileFetcher).not.toHaveBeenCalled();
    const response = await app.inject({ method: "GET", url: "/api/profile", headers: { authorization: "Bearer valid-token" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ name: "Person", email: "person@example.test" });
    expect(profileFetcher).toHaveBeenCalledWith("https://login.example.test/userinfo", expect.objectContaining({ headers: { authorization: "Bearer valid-token", accept: "application/json" } }));
  });
  it.each([{ sub: "another-user", name: "Wrong" }, null])("rejects mismatched or invalid profiles", async profile => {
    const app = buildServer({ publicConfig, verifier, backend: backend(), profileFetcher: async () => new Response(JSON.stringify(profile)) }); openServers.push(app);
    const response = await app.inject({ method: "GET", url: "/api/profile", headers: { authorization: "Bearer valid-token" } });
    expect(response.statusCode).toBe(502); expect(response.json()).toEqual({ error: "Account details unavailable" });
  });
  it("handles unavailable Auth0 without leaking upstream details", async () => {
    const app = buildServer({ publicConfig, verifier, backend: backend(), profileFetcher: async () => { throw new Error("private upstream failure"); } }); openServers.push(app);
    const response = await app.inject({ method: "GET", url: "/api/profile", headers: { authorization: "Bearer valid-token" } });
    expect(response.statusCode).toBe(502); expect(response.headers["cache-control"]).toBe("no-store");
  });
});

it("rate limits profile requests before calling Auth0 and keeps failures uncached", async () => {
  const profileFetcher = vi.fn(async () => new Response(JSON.stringify({ sub: "google-oauth2|person-123" })));
  const app = buildServer({ publicConfig, verifier, backend: backend(), profileFetcher }); openServers.push(app);
  for (let index = 0; index < 60; index++) await app.inject({ method: "GET", url: "/api/profile", headers: { authorization: "Bearer valid-token" } });
  const response = await app.inject({ method: "GET", url: "/api/profile", headers: { authorization: "Bearer valid-token" } });
  expect(response.statusCode).toBe(429); expect(response.headers["cache-control"]).toBe("no-store");
  expect(profileFetcher).toHaveBeenCalledTimes(60);
});
