import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, type Backend } from "./server.js";
import type { AgentPort } from "./agent-routes.js";
import type { RuntimeConfig } from "@mdc/contracts";
const id = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";
const config: RuntimeConfig = { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo.firebaseapp.com", projectId: "demo", storageBucket: "demo" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 };
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); });
function fixture() {
  const store = {
    authenticate: vi.fn(async (token: string) => token === "agent" ? { uid: "owner", keyId: id } : undefined),
    listContexts: vi.fn(async () => ({ records: [], cursor: null, hasMore: false })),
    listItems: vi.fn(async () => ({ records: [], cursor: null, hasMore: false })),
    writeItem: vi.fn(async () => ({ id, createdAt: 1, updatedAt: 1 })), getContext: vi.fn(async () => ({ id, createdAt: 1, updatedAt: 1 })), rename: vi.fn(async () => ({ id, createdAt: 1, updatedAt: 1 })),
    listKeys: vi.fn(async () => []), createKey: vi.fn(async () => ({ id, key: "one-time-key", name: "Test", createdAt: 1, lastUsedAt: null })), revokeKey: vi.fn(async () => {}),
    download: vi.fn(async () => ({ stream: Readable.from([Buffer.from([0, 255, 1])]), size: 3, name: "data.bin" })),
    upload: vi.fn(async (_uid, _context, _item, stream: Readable) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1])); }),
  } satisfies AgentPort;
  const backend: Backend = { createCustomToken: vi.fn(async () => "firebase-token"), completeUpload: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}), close: async () => {}, checkReady: async () => {} };
  const app = buildServer({ publicConfig: config, agents: store, backend, verifier: async token => { if (token !== "google") throw new Error(); return { uid: "owner", subject: "google-oauth2|owner" }; } });
  servers.push(app); return { app, store, backend };
}
describe("agent API trust boundaries", () => {
  it("separates agent access from Google-only key administration and session issuance", async () => {
    const { app, store } = fixture();
    expect((await app.inject({ url: "/api/agent/v1/contexts" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/agent/v1/contexts", headers: { authorization: "Bearer google" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/agent-keys", headers: { authorization: "Bearer agent" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/session", method: "POST", headers: { authorization: "Bearer agent" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/agent-keys", headers: { authorization: "Bearer google" } })).statusCode).toBe(200);
    await app.inject({ url: "/api/agent/v1/contexts", headers: { authorization: "Bearer agent" } });
    expect(store.listContexts).toHaveBeenCalledWith("owner", undefined, 50);
  });
  it("validates ownership inputs, identifiers and bodies before writes", async () => {
    const { app, backend, store } = fixture(); const headers = { authorization: "Bearer agent" };
    expect((await app.inject({ method: "POST", url: "/api/agent/v1/contexts", headers, payload: { id, uid: "victim", item: { id: itemId, content: { kind: "text", text: "hello" } } } })).statusCode).toBe(400);
    expect(store.writeItem).not.toHaveBeenCalled();
    expect((await app.inject({ method: "DELETE", url: `/api/agent/v1/contexts/${id}`, headers })).statusCode).toBe(204);
    expect(backend.deleteContext).toHaveBeenCalledWith("owner", id);
    expect((await app.inject({ url: "/api/agent/v1/contexts?limit=1000", headers })).statusCode).toBe(400);
  });
  it("streams exact bytes and rejects further requests after the per-key rate limit", async () => {
    const { app } = fixture(); const headers = { authorization: "Bearer agent" }; const url = `/api/agent/v1/contexts/${id}/items/${itemId}/content`;
    const download = await app.inject({ url, headers }); expect(download.rawPayload).toEqual(Buffer.from([0, 255, 1]));
    expect((await app.inject({ url, method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from([0, 255, 1]) })).statusCode).toBe(204);
    for (let i = 0; i < 118; i++) expect((await app.inject({ url: "/api/agent/v1/contexts", headers })).statusCode).toBe(200);
    const denied = await app.inject({ url: "/api/agent/v1/contexts", headers }); expect(denied.statusCode).toBe(429); expect(denied.headers["retry-after"]).toBeTruthy();
  });
});
