import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAccessRoutes } from "./access-routes.js";
import type { AccessAdministrationPort } from "./access.js";
const target = "00000000-0000-4000-8000-000000000001";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  const access = {
    status: vi.fn(async () => ({ passkeyRegistered: true })), devices: vi.fn(async () => []), listKeys: vi.fn(async () => []),
    registrationOptions: vi.fn(async () => ({ challengeId: target, options: {} })), register: vi.fn(async () => ({ passkeyRegistered: true })),
    challenge: vi.fn(async () => ({ challengeId: target, options: {} })), complete: vi.fn(async () => ({ kind: "revoked", id: target })),
  };
  const app = Fastify(); apps.push(app);
  registerAccessRoutes(app, { access: access as unknown as AccessAdministrationPort, origin: "https://app.example.test", verifier: async token => { if (token !== "owner") throw new Error(); return { uid: "uid", subject: "google-oauth2|owner" }; } });
  return { app, access };
}
const headers = { authorization: "Bearer owner", origin: "https://app.example.test" };
describe("access administration routes", () => {
  it("requires an owner identity and rejects native or foreign mutation origins", async () => {
    const { app, access } = fixture();
    expect((await app.inject({ url: "/api/access/status" })).statusCode).toBe(401);
    for (const origin of ["https://localhost", "https://elsewhere.test"]) expect((await app.inject({ method: "POST", url: "/api/access/passkey/registration/options", headers: { ...headers, origin } })).statusCode).toBe(403);
    expect(access.registrationOptions).not.toHaveBeenCalled();
    expect((await app.inject({ url: "/api/access/status", headers })).json()).toEqual({ passkeyRegistered: true });
  });
  it("validates exact operations before issuing challenges", async () => {
    const { app, access } = fixture(); const payload = { action: "set-device-access", targetId: target, expectedVersion: 1, mode: "all" };
    expect((await app.inject({ method: "POST", url: "/api/access/challenges", headers, payload: { ...payload, uid: "other" } })).statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: "/api/access/challenges", headers, payload });
    expect(response.statusCode).toBe(200); expect(access.challenge).toHaveBeenCalledWith("uid", payload);
  });
  it("does not accept replacement operation fields while completing a challenge", async () => {
    const { app, access } = fixture();
    expect((await app.inject({ method: "POST", url: `/api/access/challenges/${target}/complete`, headers, payload: { response: {}, mode: "all" } })).statusCode).toBe(400);
    expect(access.complete).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: `/api/access/challenges/${target}/complete`, headers, payload: { response: {} } })).statusCode).toBe(200);
    expect(access.complete).toHaveBeenCalledWith("uid", target, {});
  });
  it("limits expensive ceremonies per owner and never caches their responses", async () => {
    const { app } = fixture();
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: "POST", url: "/api/access/passkey/registration/options", headers })).statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: "/api/access/passkey/registration/options", headers });
    expect(denied.statusCode).toBe(429); expect(denied.headers["retry-after"]).toBeTruthy(); expect(denied.headers["cache-control"]).toBe("no-store");
  });
});
