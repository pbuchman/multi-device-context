import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import { FirestoreAccessAdministration } from "./access.js";

type Data = Record<string, any>;
class Database {
  values = new Map<string, Data>();
  tail: Promise<unknown> = Promise.resolve();
  doc(path: string): any {
    const snapshot = () => ({ id: path.split("/").at(-1), exists: this.values.has(path), data: () => this.values.get(path) });
    return { path, get: async () => snapshot(), create: async (data: Data) => { if (this.values.has(path)) throw new Error("exists"); this.values.set(path, data); } };
  }
  collection(path: string): any {
    const filters: [string, unknown][] = []; let maximum = Infinity;
    const query: any = { where: (key: string, _op: string, value: unknown) => { filters.push([key, value]); return query; }, limit: (n: number) => { maximum = n; return query; }, get: async () => {
      const docs = [...this.values].filter(([key, value]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).split("/").length === 1 && filters.every(([field, expected]) => value[field] === expected)).slice(0, maximum).map(([key]) => this.doc(key));
      const snapshots = await Promise.all(docs.map(ref => ref.get())); return { docs: snapshots, size: snapshots.length };
    } }; return query;
  }
  runTransaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => {}).then(async () => {
      const writes: (() => void)[] = []; let writing = false;
      const result = await work({
        get: async (ref: any) => { if (writing) throw new Error("read after write"); return ref.get(); },
        create: (ref: any, data: Data) => { writing = true; writes.push(() => { if (this.values.has(ref.path)) throw new Error("exists"); this.values.set(ref.path, data); }); },
        set: (ref: any, data: Data) => { writing = true; writes.push(() => this.values.set(ref.path, data)); },
        update: (ref: any, data: Data) => { writing = true; writes.push(() => this.values.set(ref.path, { ...this.values.get(ref.path), ...data })); },
        delete: (ref: any) => { writing = true; writes.push(() => this.values.delete(ref.path)); },
      });
      writes.forEach(write => write()); return result;
    }); this.tail = run; return run;
  }
}
const uid = "owner";
const targetId = "00000000-0000-4000-8000-000000000001";
const origin = "https://context.example.test";
function fixture() {
  const db = new Database(); let now = 1000;
  const webauthn = {
    generateRegistrationOptions: vi.fn(async () => ({ challenge: `register-${crypto.randomUUID()}` })),
    verifyRegistrationResponse: vi.fn(async () => ({ verified: true, registrationInfo: { credential: { id: "credential", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] }, credentialDeviceType: "multiDevice", credentialBackedUp: true } })),
    generateAuthenticationOptions: vi.fn(async () => ({ challenge: `authenticate-${crypto.randomUUID()}` })),
    verifyAuthenticationResponse: vi.fn(async () => ({ verified: true, authenticationInfo: { newCounter: 0 } })),
  };
  const service = new FirestoreAccessAdministration(db as unknown as Firestore, { origin, now: () => now, webauthn: webauthn as any });
  db.values.set(`users/${uid}/devices/${targetId}`, { name: "Phone", platform: "android", mode: "own", version: 1, createdAt: 1000, updatedAt: 1000 });
  const enroll = async () => { const result = await service.registrationOptions(uid); await service.register(uid, { challengeId: result.challengeId, response: {} as any }); };
  return { db, service, webauthn, enroll, later: () => { now += 300001; } };
}
const action = { action: "set-device-access" as const, targetId, expectedVersion: 1, mode: "all" as const };

describe("passkey protected access administration", () => {
  it("registers exactly one verified passkey and never saves its private material", async () => {
    const f = fixture(); await f.enroll();
    expect(await f.service.status(uid)).toEqual({ passkeyRegistered: true });
    expect(f.webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedOrigin: origin, expectedRPID: "context.example.test", requireUserVerification: true }));
    await expect(f.service.registrationOptions(uid)).rejects.toMatchObject({ statusCode: 409 });
    expect(JSON.stringify([...f.db.values])).not.toContain("privateKey");
  });
  it("serializes two first registrations so the second cannot replace the credential", async () => {
    const f = fixture(); const a = await f.service.registrationOptions(uid); const b = await f.service.registrationOptions(uid);
    const results = await Promise.allSettled([f.service.register(uid, { challengeId: a.challengeId, response: {} as any }), f.service.register(uid, { challengeId: b.challengeId, response: {} as any })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects unverified registration without closing initial enrollment", async () => {
    const f = fixture(); f.webauthn.verifyRegistrationResponse.mockResolvedValueOnce({ verified: false } as any);
    const c = await f.service.registrationOptions(uid);
    await expect(f.service.register(uid, { challengeId: c.challengeId, response: {} as any })).rejects.toMatchObject({ statusCode: 403 });
    expect(await f.service.status(uid)).toEqual({ passkeyRegistered: false });
  });
  it("requires an enrolled passkey before issuing mutation challenges", async () => {
    await expect(fixture().service.challenge(uid, action)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("binds the exact operation and atomically rejects parallel replay", async () => {
    const f = fixture(); await f.enroll(); const c = await f.service.challenge(uid, action);
    const result = await Promise.allSettled([f.service.complete(uid, c.challengeId, {} as any), f.service.complete(uid, c.challengeId, {} as any)]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(f.db.values.get(`users/${uid}/devices/${targetId}`)).toMatchObject({ mode: "all", version: 2 });
    expect(f.webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: c.options.challenge, expectedOrigin: origin, expectedRPID: "context.example.test", requireUserVerification: true }));
  });
  it("rejects an expired or another owner's challenge", async () => {
    const f = fixture(); await f.enroll(); const c = await f.service.challenge(uid, action);
    await expect(f.service.complete("someone-else", c.challengeId, {} as any)).rejects.toMatchObject({ statusCode: 404 });
    f.later(); await expect(f.service.complete(uid, c.challengeId, {} as any)).rejects.toMatchObject({ statusCode: 410 });
    expect(f.db.values.get(`users/${uid}/devices/${targetId}`)?.mode).toBe("own");
  });
  it("does not apply a stale grant after another administrator changes policy", async () => {
    const f = fixture(); await f.enroll(); const c = await f.service.challenge(uid, action);
    f.db.values.get(`users/${uid}/devices/${targetId}`)!.version = 3;
    await expect(f.service.complete(uid, c.challengeId, {} as any)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.db.values.get(`users/${uid}/devices/${targetId}`)?.mode).toBe("own");
  });
  it("does not mutate grants when the passkey assertion is invalid", async () => {
    const f = fixture(); await f.enroll(); const c = await f.service.challenge(uid, action);
    f.webauthn.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false } as any);
    await expect(f.service.complete(uid, c.challengeId, {} as any)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.db.values.get(`users/${uid}/devices/${targetId}`)?.version).toBe(1);
  });
  it("creates one agent secret through the ceremony and never persists it in plaintext", async () => {
    const f = fixture(); await f.enroll(); const c = await f.service.challenge(uid, { action: "create-agent-key", name: "Laptop" });
    const result = await f.service.complete(uid, c.challengeId, {} as any);
    expect(result.kind).toBe("agent-key"); if (result.kind !== "agent-key") throw new Error("wrong result");
    expect(result.key.key).toMatch(/^mdc_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...f.db.values])).not.toContain(result.key.key);
    expect(await f.service.listKeys(uid)).toHaveLength(1);
    await expect(f.service.complete(uid, c.challengeId, {} as any)).rejects.toMatchObject({ statusCode: 410 });
  });
  it("revokes only the owner's exact key and enforces the existing ten-key limit", async () => {
    const f = fixture(); await f.enroll();
    for (let i = 0; i < 10; i++) f.db.values.set(`agentKeys/key${i}`, { uid, name: `Key ${i}`, createdAt: 1, lastUsedAt: null });
    const c = await f.service.challenge(uid, { action: "create-agent-key", name: "Extra" });
    await expect(f.service.complete(uid, c.challengeId, {} as any)).rejects.toMatchObject({ statusCode: 409 });
    f.db.values.set(`agentKeys/${targetId}`, { uid, name: "Old", createdAt: 1, lastUsedAt: null });
    const revoke = await f.service.challenge(uid, { action: "revoke-agent-key", targetId });
    await f.service.complete(uid, revoke.challengeId, {} as any);
    expect(f.db.values.has(`agentKeys/${targetId}`)).toBe(false);
  });
});
