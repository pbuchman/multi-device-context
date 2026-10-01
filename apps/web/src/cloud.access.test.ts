import { expect, it, vi } from "vitest";
import type { FirebaseApp } from "firebase/app";
import { FirebaseCloud } from "./cloud.js";
import type { QueuedShare } from "./outbox.js";
const f = vi.hoisted(() => ({ reads: vi.fn(async () => ({ docs: [], metadata: { hasPendingWrites: false } })), listen: vi.fn(() => () => {}) }));
vi.mock("firebase/firestore", () => ({ initializeFirestore: () => ({}), memoryLocalCache: () => ({}), collection: (_db: unknown, path: string) => ({ path }), doc: () => ({}), where: (...args: unknown[]) => args, query: (ref: unknown, ...constraints: unknown[]) => ({ ref, constraints }), getDocsFromServer: f.reads, getDocs: f.reads, onSnapshot: f.listen, serverTimestamp: () => 1, updateDoc: vi.fn(), writeBatch: vi.fn(), disableNetwork: vi.fn(), enableNetwork: vi.fn(), documentId: () => "__name__", limit: () => 1 }));
vi.mock("firebase/storage", () => ({ getStorage: () => ({}) }));
const device = { id: "11111111-1111-4111-8111-111111111111", name: "Phone", platform: "android" as const, mode: "own" as "own" | "all", version: 1, createdAt: 1, updatedAt: 1 };
it("scopes context reads and both deletion feeds to the authenticated creator in own mode", async () => {
 const cloud = new FirebaseCloud({} as FirebaseApp, "uid", async () => "firebase", device);
 await cloud.refreshContexts(); await cloud.refreshDeletedContexts(); await cloud.refreshDeletedItems(); await cloud.deletionMarkers();
 expect(f.reads.mock.calls.length).toBe(5);
 for (const [query] of f.reads.mock.calls as unknown as [{ constraints: unknown[][] }][]) expect(query.constraints).toContainEqual(["originDeviceId", "==", device.id]);
});
it("does not accept a late refresh or serve any request after policy invalidation", async () => {
 const cloud = new FirebaseCloud({} as FirebaseApp, "uid", async () => "firebase", device);
 let finish!: (value: { docs: never[]; metadata: { hasPendingWrites: boolean } }) => void; f.reads.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const pending = cloud.refreshContexts(); cloud.invalidate(); finish({ docs: [], metadata: { hasPendingWrites: false } });
 await expect(pending).rejects.toThrow(/access/i); await expect(cloud.refreshContexts()).rejects.toThrow(/access/i);
});
it.each(["text/plain", "image/png"])("uploads %s with the API's raw-byte transport MIME", async contentType => {
 const firestore = await import("firebase/firestore");
 vi.mocked(firestore.writeBatch).mockReturnValue({ set: vi.fn(), update: vi.fn(), commit: async () => {} } as never);
 const calls: RequestInit[] = []; let completions = 0;
 vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
   calls.push(init);
   if (init.method === "PUT") return new Response(null, { status: 204 });
   return new Response(null, { status: ++completions === 1 ? 404 : 204 });
 }));
 try {
   const cloud = new FirebaseCloud({} as FirebaseApp, "uid", async () => "firebase", device);
   await cloud.publish({ contextId: "11111111-1111-4111-8111-111111111112", itemId: "11111111-1111-4111-8111-111111111113", title: "File", createsContext: true, device: { id: device.id, name: device.name }, content: { kind: "attachment", name: "file", contentType, size: 3 }, bytes: new Uint8Array([0, 255, 1]) } as QueuedShare);
   expect(calls.find(call => call.method === "PUT")?.headers).toMatchObject({ authorization: "Bearer firebase", "content-type": "application/octet-stream" });
 } finally { vi.unstubAllGlobals(); }
});
