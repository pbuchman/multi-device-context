// Emulator-only browser integration entry; not a production build entrypoint.
import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, connectFirestoreEmulator, doc, writeBatch, serverTimestamp, getDocFromServer, getDocFromCache } from "firebase/firestore";
import { prepareHistory } from "./history.js";
import { DraftStore, emptyDraft } from "./drafts.js";
import { DurableOutbox } from "./outbox.js";
if (location.hostname !== "127.0.0.1") throw new Error("Local emulator only");
const app = initializeApp({ projectId: "demo-mdc", apiKey: "emulator-only" }, "migration-proof");
const legacy = new URLSearchParams(location.search).has("legacy");
const configure = (db: Parameters<typeof connectFirestoreEmulator>[0]) => connectFirestoreEmulator(db, "127.0.0.1", 18080, { mockUserToken: { sub: "migration-user" } });
if (!legacy) await prepareHistory(app, configure);
const db = initializeFirestore(app, { localCache: legacy ? persistentLocalCache({ tabManager: persistentMultipleTabManager() }) : memoryLocalCache() });
configure(db);
const contextId = "00000000-0000-4000-8000-000000000001", itemId = "00000000-0000-4000-8000-000000000002";
const path = `users/migration-user/contexts/${contextId}`;
const itemRef = doc(db, `${path}/items/${itemId}`);
const drafts = new DraftStore("demo-mdc:migration-user");
const outbox = new DurableOutbox({ projectId: "demo-mdc", uid: "migration-user" });
const device = { id: contextId, name: "Synthetic" };
Object.assign(window, { historyProof: {
  seed: async () => {
    const batch = writeBatch(db); batch.set(doc(db, path), { title: "Fixture", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), deleting: false });
    batch.set(itemRef, { content: { kind: "text", text: "SYNTHETIC_OLD_HISTORY" }, device, createdAt: serverTimestamp(), ready: true, deleting: false });
    await batch.commit(); await getDocFromServer(itemRef);
    await drafts.save(contextId, { ...emptyDraft(), text: "SYNTHETIC_UNSENT_DRAFT" });
    await outbox.enqueue({ contextId, itemId, title: "Unsent", content: { kind: "text", text: "SYNTHETIC_UNSENT_QUEUE" }, device, createsContext: false });
  },
  cache: async () => { try { return (await getDocFromCache(itemRef)).data()?.content.text ?? null; } catch { return null; } },
  saveDraft: async (id: string, text: string) => drafts.save(id, { ...emptyDraft(), text }),
  local: async () => ({ drafts: await drafts.list(), queue: await outbox.list(), databases: await indexedDB.databases() }),
} });
