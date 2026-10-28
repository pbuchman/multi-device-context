/// <reference path="../../web/src/env.d.ts" />
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { emulatorAddress } from "../../../infra/emulator-address.js";
import { DeviceAccessStore } from "./device-access.js";
import { FirebaseBackend } from "./firebase.js";
import { buildServer } from "./server.js";
import { ContextOperations } from "../../web/src/operations.js";
import { DurableOutbox, PublishFailure } from "../../web/src/outbox.js";
import { applyLocalAccess } from "../../web/src/local-access.js";
import { done, openLocalDatabase } from "../../web/src/local-db.js";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_EMULATOR_HUB) throw new Error("An emulator CLI session is required");
const projectId = "demo-mdc", uid = "deletion-recovery-owner", deviceId = randomUUID(), foreign = randomUUID();
const app = initializeApp({ projectId }, "deletion-recovery-integration"), db = getFirestore(app);
const policy = db.doc(`users/${uid}/devices/${deviceId}`);
const grant = (mode: "own" | "all") => ({ name: "Synthetic browser", platform: "browser", mode, version: 1, createdAt: 1, updatedAt: 1 });
const backend = new FirebaseBackend({ firestore: db, bucket: { getFiles: async () => [[]] } as never, auth: {} as never });
const devices = new DeviceAccessStore(db, { verifyIdToken: async (token: string) => {
  if (token !== "synthetic-device-token") throw new Error(); return { uid, mdcDeviceId: deviceId };
} } as never);
const server = buildServer({
  publicConfig: { appOrigin: "https://app.example.test", auth0: { domain: "login.example.test", audience: "api", webClientId: "web", nativeClientId: "native", connection: "google-oauth2" }, firebase: { apiKey: "public", authDomain: "demo-mdc.firebaseapp.com", projectId, storageBucket: "demo-mdc.appspot.com" }, limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 }, bridgeVersion: 1 },
  verifier: async () => { throw new Error(); }, backend, devices,
});
let env: RulesTestEnvironment;
let emulatorVerified = false;
const path = (id: string) => `users/${uid}/contexts/${id}`;
const context = () => ({ title: "Synthetic", originDeviceId: deviceId, deleting: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
const item = () => ({ content: { kind: "text", text: "Synthetic queued text" }, device: { id: deviceId, name: "Synthetic browser" }, deleting: false, ready: true, createdAt: serverTimestamp() });
const headers = { authorization: "Bearer synthetic-device-token" };
async function remove(contextId: string, itemId?: string, final = false) {
  return server.inject({ method: "DELETE", url: `/api/contexts/${contextId}${itemId ? `/items/${itemId}` : ""}`, headers, ...(final ? { payload: { deleteEmptyContext: true } } : {}) });
}
beforeAll(async () => {
  const running = await (await fetch(`http://${process.env.FIREBASE_EMULATOR_HUB}/emulators`)).json() as { firestore?: { host: string; port: number } };
  expect(`${running.firestore?.host}:${running.firestore?.port}`).toBe(process.env.FIRESTORE_EMULATOR_HOST);
  emulatorVerified = true;
  await db.recursiveDelete(db.doc(`users/${uid}`));
  env = await initializeTestEnvironment({ projectId, firestore: { ...emulatorAddress(process.env.FIRESTORE_EMULATOR_HOST), rules: await readFile("infra/firestore.rules", "utf8") } });
});
beforeEach(async () => { globalThis.indexedDB = new IDBFactory(); await policy.set(grant("own")); });
afterAll(async () => { await server.close(); await env?.cleanup(); if (emulatorVerified) await db.recursiveDelete(db.doc(`users/${uid}`)); await deleteApp(app); });

it.each(["own", "all"] as const)("returns 204 only after an absent %s context tombstone is committed; lost-response retry clears durable intent", async mode => {
  await policy.set(grant(mode));
  const id = randomUUID(), box = new DurableOutbox({ projectId, uid });
  await applyLocalAccess(box.namespace, { id: deviceId, mode, version: 1 }, [id]);
  let loseResponse = true;
  const operations = new ContextOperations(box, {
    deletionMarkers: async () => ({ contexts: [], items: [] }), publish: async () => {}, deleteItem: async () => {},
    deleteContext: async target => {
      const reply = await remove(target);
      expect(reply.statusCode).toBe(204);
      expect((await db.doc(`users/${uid}/deletedContexts/${id}`).get()).data()).toEqual({ deleted: true, originDeviceId: deviceId });
      if (loseResponse) { loseResponse = false; throw new TypeError("synthetic lost response"); }
    },
  });
  expect(await operations.remove(id)).toBe(false); operations.runner.stop();
  expect(await box.deletions()).toEqual([expect.objectContaining({ paused: false, errorCategory: "network" })]);
  await box.retry();
  operations.runner.resume();
  await operations.runner.drain();
  await operations.runner.stopAndWait();
  expect(await box.deletions()).toEqual([]); box.close();
});
it("allows the old hosted client's explicit Retry to finish an unversioned paused 404 deletion before UI update", async () => {
  const id = randomUUID(), box = new DurableOutbox({ projectId, uid });
  await applyLocalAccess(box.namespace, { id: deviceId, mode: "own", version: 1 }, [id]);
  const local = await openLocalDatabase(), tx = local.transaction("records", "readwrite"), complete = done(tx);
  tx.objectStore("records").put({ key: `deletion:${box.namespace}:${id}:context`, kind: "deletion", namespace: box.namespace, contextId: id, paused: true, attempts: 1, nextAttemptAt: 1000 });
  await complete; local.close();
  const operations = new ContextOperations(box, { deletionMarkers: async () => ({ contexts: [], items: [] }), publish: async () => {}, deleteItem: async () => {}, deleteContext: async target => {
    const reply = await remove(target); if (reply.statusCode !== 204) throw new PublishFailure("Deletion failed", false);
  } });
  await box.retry(); await operations.runner.drain(); operations.runner.stop();
  expect(await box.deletions()).toEqual([]);
  expect((await db.doc(`users/${uid}/deletedContexts/${id}`).get()).data()).toEqual({ deleted: true, originDeviceId: deviceId }); box.close();
});
it.each([false, true])("confirms absent items and repeated deletion after parent cleanup (%s)", async final => {
  const id = randomUUID(), target = randomUUID();
  expect((await remove(id, target, final)).statusCode).toBe(204);
  expect((await db.doc(`users/${uid}/deletedItems/${id}_${target}`).get()).data()).toEqual({ deleted: true, originDeviceId: deviceId });
  expect((await remove(id)).statusCode).toBe(204);
  expect((await remove(id, randomUUID(), final)).statusCode).toBe(204);
});
it("denies a revoked identity and foreign own-mode markers while preserving full-mode provenance", async () => {
  const id = randomUUID(), marker = db.doc(`users/${uid}/deletedContexts/${id}`);
  await marker.set({ deleted: true, originDeviceId: foreign });
  expect((await remove(id)).statusCode).toBe(404);
  expect((await remove(id, randomUUID())).statusCode).toBe(404);
  await policy.update({ mode: "all" }); expect((await remove(id)).statusCode).toBe(204);
  expect((await marker.get()).data()?.originDeviceId).toBe(foreign);
  await policy.delete(); expect((await remove(randomUUID())).statusCode).toBe(401);
});
it("serializes offline initial publication and DELETE so an authorized tombstone prevents resurrection", async () => {
  const client = env.authenticatedContext(uid, { mdcDeviceId: deviceId }).firestore();
  for (let n = 0; n < 4; n++) {
      const id = randomUUID(), target = randomUUID();
      const publish = () => { const batch = writeBatch(client); batch.set(doc(client, path(id)), context()); batch.set(doc(client, `${path(id)}/items/${target}`), item()); return batch.commit(); };
      const results = await Promise.allSettled([publish(), remove(id)]);
      expect(results[1]).toMatchObject({ status: "fulfilled", value: { statusCode: 204 } });
      expect((await db.doc(path(id)).get()).exists).toBe(false);
      expect((await db.doc(`users/${uid}/deletedContexts/${id}`).get()).data()?.originDeviceId).toBe(deviceId);
      await assertFails(publish());
  }
});
it("retains a concurrently published sibling or rejects it while conditional final-item deletion commits", async () => {
  const client = env.authenticatedContext(uid, { mdcDeviceId: deviceId }).firestore();
  for (let n = 0; n < 4; n++) {
      const id = randomUUID(), target = randomUUID(), sibling = randomUUID(), parent = db.doc(path(id));
      await parent.set({ title: "Synthetic", originDeviceId: deviceId, deleting: false, firstItemId: target });
      await parent.collection("items").doc(target).set({ deleting: false, ready: true, createdAt: new Date() });
      const [published, deleted] = await Promise.allSettled([setDoc(doc(client, `${path(id)}/items/${sibling}`), item()), remove(id, target, true)]);
      expect(deleted).toMatchObject({ status: "fulfilled", value: { statusCode: 204 } });
      const savedSibling = await parent.collection("items").doc(sibling).get(), savedParent = await parent.get();
      if (published.status === "fulfilled") {
        expect(savedSibling.exists).toBe(true); expect(savedParent.data()?.deleting).toBe(false);
        expect((await db.doc(`users/${uid}/deletedContexts/${id}`).get()).exists).toBe(false);
      } else { expect(savedSibling.exists).toBe(false); expect(savedParent.exists).toBe(false); }
  }
});
