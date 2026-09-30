import type { FirebaseApp } from "firebase/app";
import { clearIndexedDbPersistence, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager, terminate, waitForPendingWrites, type Firestore } from "firebase/firestore";
/** A legacy profile is migrated online, preserving acknowledged writes and the independent outbox. */
export async function prepareHistory(app: FirebaseApp, configure?: (db: Firestore) => void): Promise<void> {
  const key = `mdc-memory-history:${app.name}`;
  if (localStorage.getItem(key) === "2") return;
  const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : undefined;
  const legacy = !databases || databases.some(d => d.name?.startsWith("firestore/") && d.name.includes(app.name));
  if (legacy) {
    if (!navigator.onLine) throw new Error("Connect to finish updating local history. Your drafts and pending shares are preserved.");
    const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    configure?.(db);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([waitForPendingWrites(db), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Connect and close older Contexts tabs, then retry the local history update.")), 15_000); })]);
      await terminate(db);
      await clearIndexedDbPersistence(db);
    } catch {
      await terminate(db).catch(() => {});
      throw new Error("Local history update is incomplete. Connect, close older Contexts tabs and retry. Pending shares are preserved.");
    } finally { clearTimeout(timeout); }
  } else {
    const db = initializeFirestore(app, { localCache: memoryLocalCache() });
    await terminate(db); await clearIndexedDbPersistence(db);
  }
  localStorage.setItem(key, "2");
}
