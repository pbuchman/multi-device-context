import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { beforeAll, afterAll, expect, it } from "vitest";
import { DeviceAccessStore } from "./device-access.js";
import { AttachmentStore } from "./attachments.js";
import { FirebaseBackend } from "./firebase.js";
import { buildServer } from "./server.js";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) throw new Error("Emulators required");
const app = initializeApp({ projectId: "demo-mdc", storageBucket: "demo-mdc.appspot.com" }, "device-streaming-integration");
const db = getFirestore(app), bucket = getStorage(app).bucket();
const uid = "device-streaming-owner", deviceId = randomUUID();
const backend = new FirebaseBackend({ firestore: db, bucket, auth: getAuth(app) });
const devices = new DeviceAccessStore(db, { verifyIdToken: async (token: string) => { if (token !== "firebase") throw new Error(); return { uid, mdcDeviceId: deviceId }; } } as never);
const server = buildServer({
  publicConfig: { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo-mdc.firebaseapp.com", projectId: "demo-mdc", storageBucket: "demo-mdc.appspot.com" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 },
  verifier: async () => { throw new Error(); }, backend, devices, attachments: new AttachmentStore(db, bucket, backend),
});
beforeAll(async () => {
  await db.recursiveDelete(db.doc(`users/${uid}`));
  await db.doc(`users/${uid}/devices/${deviceId}`).set({ name: "Phone", platform: "android", mode: "own", version: 1, createdAt: 1, updatedAt: 1 });
});
afterAll(async () => { await server.close(); await db.recursiveDelete(db.doc(`users/${uid}`)); await bucket.deleteFiles({ prefix: `users/${uid}/` }); await deleteApp(app); });
it.each([
  ["text/plain", Buffer.from("Zażółć gęślą jaźń\n", "utf8")],
  ["image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6gAAAABJRU5ErkJggg==", "base64")],
])("round-trips %s through actual app streaming routes, preserving bytes and stored MIME", async (contentType, bytes) => {
  const contextId = randomUUID(), itemId = randomUUID(), parent = db.doc(`users/${uid}/contexts/${contextId}`);
  await parent.set({ title: "Synthetic", originDeviceId: deviceId, deleting: false, firstItemId: itemId, ready: false });
  await parent.collection("items").doc(itemId).set({ content: { kind: "attachment", name: "test-file", contentType, size: bytes.length }, deleting: false, ready: false });
  const url = `/api/contexts/${contextId}/items/${itemId}/content`, headers = { authorization: "Bearer firebase" };
  expect((await server.inject({ method: "PUT", url, headers: { ...headers, "content-type": "application/octet-stream" }, payload: bytes })).statusCode).toBe(204);
  const response = await server.inject({ url, headers });
  expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(bytes);
  expect(response.headers["content-type"]).toBe(contentType);
  expect(response.headers["content-disposition"]).toMatch(/^attachment;/);
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  await db.doc(`users/${uid}/devices/${deviceId}`).update({ mode: "all" });
  await parent.update({ originDeviceId: randomUUID() });
  expect((await server.inject({ url, headers })).statusCode).toBe(200);
  await db.doc(`users/${uid}/devices/${deviceId}`).update({ mode: "own" });
  expect((await server.inject({ url, headers })).statusCode).toBe(404);
});
