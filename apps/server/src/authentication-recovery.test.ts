import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@mdc/contracts";
import { AgentStore } from "./agent-store.js";
import { DeviceAccessStore } from "./device-access.js";
import { FirebaseBackend } from "./firebase.js";
import { DependencyUnavailable } from "./io-watchdog.js";
import { buildServer } from "./server.js";

const contextId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";
const deviceId = "00000000-0000-4000-8000-000000000010";
const agentToken = `mdc_${deviceId}_${"a".repeat(43)}`;
const config: RuntimeConfig = {
  appOrigin: "https://app.example.test",
  auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" },
  firebase: { apiKey: "public", authDomain: "demo.firebaseapp.com", projectId: "demo-mdc", storageBucket: "demo-mdc" },
  limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1,
};
const servers: ReturnType<typeof buildServer>[] = [];
const finishHangs: (() => void)[] = [];
afterEach(async () => {
  finishHangs.splice(0).forEach(finish => finish());
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  await Promise.all(servers.splice(0).map(app => app.close()));
  vi.useRealTimers();
});
function hung<T>(value: T) {
  let finish!: () => void;
  const pending = new Promise<T>(resolve => { finish = () => resolve(value); });
  finishHangs.push(finish);
  return { pending, finish };
}
const device = { name: "Phone", platform: "android", mode: "all", version: 1, createdAt: 1, updatedAt: 1 };
function fixture() {
  const claims = { uid: "owner", mdcDeviceId: deviceId };
  const key = { uid: "owner", digest: createHash("sha256").update(agentToken).digest("hex"), lastUsedAt: 0 };
  const auth = { verifyIdToken: vi.fn(async (_token: string) => claims) };
  const readDevice = vi.fn(async () => ({ data: () => device }));
  const readKey = vi.fn(async () => ({ data: () => key }));
  const writeKey = vi.fn(async (_data: unknown) => {});
  const db = { doc: (path: string) => {
    if (path === "internalHealth/readiness") return { get: async () => ({}) };
    if (path === `users/owner/devices/${deviceId}`) return { get: readDevice };
    if (path === `agentKeys/${deviceId}`) return { get: readKey, update: writeKey };
    throw new Error("Unexpected synthetic document");
  } };
  const bucket = { getMetadata: async () => [{}] };
  const onFatal = vi.fn();
  const backend = new FirebaseBackend({ firestore: db as never, bucket: bucket as never, auth: auth as never, onFatal });
  const deleteContext = vi.spyOn(backend, "deleteContext").mockResolvedValue();
  const deleteItem = vi.spyOn(backend, "deleteItem").mockResolvedValue();
  const devices = new DeviceAccessStore(db as never, auth as never, backend.dependencyGuard);
  const agents = new AgentStore(db as never, bucket as never, backend);
  const app = buildServer({ publicConfig: config, verifier: async () => ({ uid: "owner", subject: "google-oauth2|owner" }), devices, agents, backend });
  servers.push(app);
  const request = (kind: "device" | "agent", target = "context") => app.inject({
    method: "DELETE", url: `${kind === "agent" ? "/api/agent/v1" : "/api"}/contexts/${contextId}${target === "item" ? `/items/${itemId}` : ""}`,
    headers: { authorization: `Bearer ${kind === "agent" ? agentToken : "firebase-token"}` },
  }).then(response => response);
  return { app, backend, auth, claims, device, key, readDevice, readKey, writeKey, onFatal, deleteContext, deleteItem, request };
}
function fakeTime() { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] }); }
const cases = [
  { kind: "device", operation: "token" }, { kind: "device", operation: "device-read" },
  { kind: "agent", operation: "key-read" }, { kind: "agent", operation: "last-used-write" },
] as const;
describe("deletion authentication recovery", () => {
  for (const { kind, operation } of cases) it.each(["context", "item"])(`bounds hung ${kind} ${operation} on DELETE %s using the backend fatal latch`, async target => {
    fakeTime();
    const f = fixture();
    await f.app.ready();
    const pending = operation === "token" ? hung(f.claims)
      : operation === "device-read" ? hung({ data: () => f.device })
      : operation === "key-read" ? hung({ data: () => f.key }) : hung(undefined);
    const stalled = operation === "token" ? f.auth.verifyIdToken : operation === "device-read" ? f.readDevice : operation === "key-read" ? f.readKey : f.writeKey;
    stalled.mockImplementationOnce(() => pending.pending as never);
    const response = f.request(kind, target);
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await Promise.race([response, Promise.resolve("still-running")]);
    expect(result).toMatchObject({ statusCode: 503 });
    if (typeof result !== "string") expect(result.json()).toEqual({ error: "Service Unavailable" });
    expect(f.backend.isFatal()).toBe(true);
    expect(f.onFatal).toHaveBeenCalledTimes(1);
    expect((await f.app.inject({ url: "/health/ready" })).statusCode).toBe(503);
    // A different authentication entry point must see the same fatal latch.
    const other = kind === "device" ? "agent" : "device";
    const tokenCalls = f.auth.verifyIdToken.mock.calls.length, keyReads = f.readKey.mock.calls.length;
    expect((await f.request(other, target)).statusCode).toBe(503);
    expect(f.auth.verifyIdToken).toHaveBeenCalledTimes(tokenCalls);
    expect(f.readKey).toHaveBeenCalledTimes(keyReads);
    pending.finish();
    await vi.advanceTimersByTimeAsync(0);
    if (operation === "token") expect(f.readDevice).not.toHaveBeenCalled();
    if (operation === "key-read") expect(f.writeKey).not.toHaveBeenCalled();
    expect(f.deleteContext).not.toHaveBeenCalled();
    expect(f.deleteItem).not.toHaveBeenCalled();
    expect(f.onFatal).toHaveBeenCalledTimes(1);
  });

  it.each(["device", "agent"] as const)("allows separate progressing %s authentication calls to take forty seconds", async kind => {
    fakeTime();
    const f = fixture();
    const delay = async <T,>(value: T) => { await new Promise(resolve => setTimeout(resolve, 20_000)); return value; };
    if (kind === "device") {
      f.auth.verifyIdToken.mockImplementationOnce(() => delay(f.claims));
      f.readDevice.mockImplementationOnce(() => delay({ data: () => f.device }));
    } else {
      f.readKey.mockImplementationOnce(() => delay({ data: () => f.key }));
      f.writeKey.mockImplementationOnce(() => delay(undefined));
    }
    await f.app.ready();
    const response = f.request(kind);
    await vi.waitFor(() => expect(kind === "device" ? f.auth.verifyIdToken : f.readKey).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await response).statusCode).toBe(204);
    expect(f.deleteContext).toHaveBeenCalledTimes(1);
    expect(f.onFatal).not.toHaveBeenCalled();
  });

  for (const kind of ["device", "agent"] as const) it.each(["context", "item"])(`preserves trusted unavailable errors from ${kind} DELETE %s`, async target => {
    const f = fixture();
    f.deleteContext.mockRejectedValue(new DependencyUnavailable());
    f.deleteItem.mockRejectedValue(new DependencyUnavailable());
    const response = await f.request(kind, target);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Service Unavailable" });
  });

  it.each(["device", "agent"] as const)("sanitizes arbitrary %s SDK 503 errors as internal failures", async kind => {
    const f = fixture();
    f.deleteContext.mockRejectedValue(Object.assign(new Error("PRIVATE_SENTINEL"), { statusCode: 503 }));
    const response = await f.request(kind);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("PRIVATE_SENTINEL");
  });

  it.each(["device", "agent"] as const)("retains 401 for invalid %s credentials without fatal recovery", async kind => {
    const f = fixture();
    if (kind === "device") f.auth.verifyIdToken.mockRejectedValueOnce(new Error("PRIVATE_TOKEN_SENTINEL"));
    else f.readKey.mockResolvedValueOnce({ data: () => ({ ...f.key, digest: "00" }) });
    const response = await f.request(kind);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
    expect(f.onFatal).not.toHaveBeenCalled();
    expect(f.deleteContext).not.toHaveBeenCalled();
  });
});
