import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@mdc/contracts";
import { buildServer, type Backend } from "./server.js";
import type { DeviceAccessPort } from "./device-access.js";
import type { ContextOriginsPort } from "./context-origins.js";

const id = "00000000-0000-4000-8000-000000000001";
const device = { id, name: "Radio", platform: "android" as const, mode: "own" as const, version: 1, createdAt: 1, updatedAt: 1 };
const config: RuntimeConfig = { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo.firebaseapp.com", projectId: "demo", storageBucket: "demo" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 };
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

function fixture() {
  const contextOrigins: ContextOriginsPort = { get: vi.fn(async () => ({ records: [{ id, name: "Radio", colorIndex: 0 }] })) };
  const devices = { authenticate: vi.fn(async (token: string) => { if (token !== "firebase") throw new Error("Unbound token"); return { uid: "owner", device }; }) } as unknown as DeviceAccessPort;
  const backend: Backend = { createCustomToken: async () => "custom", completeUpload: async () => {}, deleteContext: async () => {}, deleteItem: async () => {}, checkReady: async () => {}, close: async () => {} };
  const app = buildServer({ publicConfig: config, devices, backend, contextOrigins, verifier: vi.fn(async () => ({ uid: "owner", subject: "google-oauth2|owner" })) });
  servers.push(app);
  return { app, contextOrigins };
}

describe("POST /api/context-origins", () => {
  it("authenticates installation-bound Firebase sessions with no account/agent fallback", async () => {
    const { app, contextOrigins } = fixture();
    for (const authorization of [undefined, "Bearer auth0", "Bearer mdc_agent", "Bearer wrong", "Basic firebase"]) {
      const response = await app.inject({ method: "POST", url: "/api/context-origins", headers: authorization ? { authorization } : {}, payload: { contextIds: [id] } });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(contextOrigins.get).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url: "/api/context-origins", headers: { authorization: "Bearer firebase" }, payload: { contextIds: [id, id] } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ records: [{ id, name: "Radio", colorIndex: 0 }] });
    expect(contextOrigins.get).toHaveBeenCalledWith({ uid: "owner", deviceId: id }, [id, id]);
  });

  it("rejects malformed or excessive bodies before reading any origins", async () => {
    const { app, contextOrigins } = fixture();
    for (const payload of [{}, [], { contextIds: ["bad"] }, { contextIds: Array(101).fill(id) }, { contextIds: [id], uid: "other" }, { contextIds: [id], name: "Manual" }, { contextIds: [id], colorIndex: 2 }]) {
      const response = await app.inject({ method: "POST", url: "/api/context-origins", headers: { authorization: "Bearer firebase" }, payload });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const large = await app.inject({ method: "POST", url: "/api/context-origins", headers: { authorization: "Bearer firebase" }, payload: { contextIds: [], excess: "a".repeat(8_192) } });
    expect(large.statusCode).toBe(413);
    expect(large.headers["cache-control"]).toBe("no-store");
    expect(contextOrigins.get).not.toHaveBeenCalled();
  });

  it("does not cache service errors", async () => {
    const { app, contextOrigins } = fixture();
    vi.mocked(contextOrigins.get).mockRejectedValueOnce(Object.assign(new Error("Revoked"), { statusCode: 401 }));
    const response = await app.inject({ method: "POST", url: "/api/context-origins", headers: { authorization: "Bearer firebase" }, payload: { contextIds: [] } });
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
