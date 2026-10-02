import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, type Backend } from "./server.js";
import type { DeviceAccessPort } from "./device-access.js";
import type { RuntimeConfig } from "@mdc/contracts";
import { Readable } from "node:stream";
const id = "00000000-0000-4000-8000-000000000010";
const config: RuntimeConfig = { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo.firebaseapp.com", projectId: "demo", storageBucket: "demo" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 };
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
function fixture() {
  const device = { id, name: "Phone", platform: "android" as const, mode: "own" as "own" | "all", version: 1, createdAt: 1, updatedAt: 1 };
  const devices: DeviceAccessPort = {
    enroll: vi.fn(async (_uid, input) => ({ device: { ...device, ...input }, credential: "a".repeat(43) })),
    exchange: vi.fn(async (_uid, deviceId, credential) => { if (deviceId !== id || credential !== "a".repeat(43)) throw new Error(); return device; }),
    authenticate: vi.fn(async token => { if (token !== "firebase") throw new Error(); return { uid: "owner", device }; }),
  };
  const backend: Backend = { createCustomToken: vi.fn(async () => "custom"), completeUpload: vi.fn(async () => {}), deleteContext: vi.fn(async () => {}), deleteItem: vi.fn(async () => {}), checkReady: async () => {}, close: async () => {} };
  const settings = { get: vi.fn(async () => ({ aiTitlesEnabled: false })), set: vi.fn(async (_uid: string, value: { aiTitlesEnabled: boolean }) => value) };
  const attachments = { download: vi.fn(async () => ({ stream: Readable.from([Buffer.from([0, 255, 1])]), size: 3, name: "note.bin", contentType: "application/octet-stream" })), upload: vi.fn(async (_uid: string, _cid: string, _iid: string, stream: Readable) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1])); }) };
  const app = buildServer({ publicConfig: config, devices, backend, settings, attachments, verifier: async token => { if (token !== "google") throw new Error(); return { uid: "owner", subject: "google-oauth2|owner" }; } });
  servers.push(app); return { app, devices, backend, settings, device, attachments };
}
const google = { authorization: "Bearer google" };
describe("device session boundaries", () => {
  it("will not mint a user-only token; new installs cannot request full access or another ID", async () => {
    const { app, backend, devices } = fixture();
    expect((await app.inject({ method: "POST", url: "/api/session", headers: google })).statusCode).toBe(428);
    expect(backend.createCustomToken).not.toHaveBeenCalled();
    for (const extra of [{ mode: "all" }, { id }]) expect((await app.inject({ method: "POST", url: "/api/devices/enroll", headers: google, payload: { name: "Radio", platform: "android", ...extra } })).statusCode).toBe(400);
    expect(devices.enroll).not.toHaveBeenCalled();
    const enrolled = await app.inject({ method: "POST", url: "/api/devices/enroll", headers: google, payload: { name: "Radio", platform: "android" } });
    expect(enrolled.statusCode).toBe(201); expect(enrolled.json().device.mode).toBe("own");
    const session = await app.inject({ method: "POST", url: "/api/session", headers: google, payload: { deviceId: id, credential: enrolled.json().credential } });
    expect(session.statusCode).toBe(200); expect(backend.createCustomToken).toHaveBeenCalledWith("owner", id);
    expect((await app.inject({ method: "POST", url: "/api/session", headers: google, payload: { deviceId: id, credential: "b".repeat(43) } })).statusCode).toBe(403);
  });
  it("keeps browser credential HttpOnly, requires Auth0 in addition to cookie, and never accepts it from a native origin", async () => {
    const { app } = fixture();
    const enrolled = await app.inject({ method: "POST", url: "/api/devices/enroll", headers: { ...google, origin: config.appOrigin }, payload: { name: "Browser", platform: "browser" } });
    expect(enrolled.statusCode).toBe(201); expect(enrolled.json()).not.toHaveProperty("credential");
    const cookie = String(enrolled.headers["set-cookie"]); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Strict");
    const cookies = cookie.split(";", 1)[0]!;
    expect((await app.inject({ method: "POST", url: "/api/session", headers: { cookie: cookies } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/session", headers: { ...google, cookie: cookies, origin: config.appOrigin } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/session", headers: { ...google, cookie: cookies, origin: "https://localhost" } })).statusCode).toBe(428);
  });
  it("uses only installation-bound Firebase tokens for app data and blocks account setting mutation in own mode", async () => {
    const { app, device, settings } = fixture();
    expect((await app.inject({ url: "/api/device", headers: google })).statusCode).toBe(401);
    const headers = { authorization: "Bearer firebase" };
    expect((await app.inject({ url: "/api/device", headers })).json()).toMatchObject({ id, mode: "own" });
    expect((await app.inject({ url: "/api/settings", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { aiTitlesEnabled: true } })).statusCode).toBe(403);
    expect(settings.set).not.toHaveBeenCalled(); device.mode = "all";
    expect((await app.inject({ method: "PATCH", url: "/api/settings", headers, payload: { aiTitlesEnabled: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/agent-keys", headers: google, payload: { name: "bypass" } })).statusCode).toBe(404);
  });
  it("streams application attachments through bound sessions with no Auth0-only fallback", async () => {
    const { app, attachments } = fixture(); const url = `/api/contexts/${id}/items/${id}/content`;
    expect((await app.inject({ url, headers: google })).statusCode).toBe(401);
    const headers = { authorization: "Bearer firebase" };
    const response = await app.inject({ url, headers }); expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(Buffer.from([0, 255, 1]));
    expect(attachments.download).toHaveBeenCalledWith("owner", id, id, { uid: "owner", deviceId: id });
    expect((await app.inject({ url, method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from([0, 255, 1]) })).statusCode).toBe(204);
    expect(attachments.upload).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url, method: "PUT", headers: { ...headers, "content-type": "text/plain" }, payload: "file" })).statusCode).toBe(415);
  });
});
