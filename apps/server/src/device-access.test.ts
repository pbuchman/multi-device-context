import { describe, expect, it, vi } from "vitest";
import { DeviceAccessStore } from "./device-access.js";

function fixture() {
  const documents = new Map<string, Record<string, unknown>>();
  const db = {
    doc(path: string) {
      return { path, id: path.split("/").at(-1), get: async () => ({ exists: documents.has(path), data: () => documents.get(path) }),
        create: async (data: Record<string, unknown>) => { if (documents.has(path)) throw new Error("exists"); documents.set(path, data); } };
    },
    async runTransaction<T>(operation: (tx: unknown) => Promise<T>) {
      const writes: (() => void)[] = [];
      const result = await operation({ get: (ref: { get(): unknown }) => ref.get(), create: (ref: { path: string }, data: Record<string, unknown>) => writes.push(() => documents.set(ref.path, data)) });
      writes.forEach(write => write()); return result;
    },
  };
  let claims: Record<string, unknown> = { uid: "owner" };
  const auth = { verifyIdToken: vi.fn(async (token: string) => { if (token !== "firebase") throw new Error("token"); return claims; }) };
  const store = new DeviceAccessStore(db as never, auth as never);
  return { store, documents, auth, claims: (value: Record<string, unknown>) => { claims = value; } };
}

describe("registered installation access", () => {
  it("enrolls with server ID and own-only access; stores no raw credential", async () => {
    const f = fixture(); const result = await f.store.enroll("owner", { name: "Radio", platform: "android" });
    expect(result.device).toMatchObject({ name: "Radio", mode: "own", version: 1 });
    expect(result.device.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...f.documents])).not.toContain(result.credential);
    expect(await f.store.exchange("owner", result.device.id, result.credential)).toEqual(result.device);
    await expect(f.store.exchange("other", result.device.id, result.credential)).rejects.toMatchObject({ statusCode: 401 });
    await expect(f.store.exchange("owner", result.device.id, "a".repeat(43))).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects legacy/user-only and forged installation tokens and reads the current grant on every request", async () => {
    const f = fixture(); const { device } = await f.store.enroll("owner", { name: "Phone", platform: "android" });
    await expect(f.store.authenticate("firebase")).rejects.toMatchObject({ statusCode: 401 });
    f.claims({ uid: "owner", mdcDeviceId: device.id });
    expect((await f.store.authenticate("firebase")).device.mode).toBe("own");
    const path = `users/owner/devices/${device.id}`;
    f.documents.set(path, { ...f.documents.get(path), mode: "all", version: 2 });
    expect((await f.store.authenticate("firebase")).device.mode).toBe("all");
    f.documents.set(path, { ...f.documents.get(path), mode: "own", version: 3 });
    expect((await f.store.authenticate("firebase")).device.mode).toBe("own");
    f.claims({ uid: "other", mdcDeviceId: device.id });
    await expect(f.store.authenticate("firebase")).rejects.toMatchObject({ statusCode: 401 });
    await expect(f.store.authenticate("auth0")).rejects.toMatchObject({ statusCode: 401 });
  });
});
