export const DATABASE_NAME = "mdc-outbox-v1";
export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Local transaction aborted")); });
}
export function openLocalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      for (const name of ["records", "drafts"]) if (!request.result.objectStoreNames.contains(name)) {
        const store = request.result.createObjectStore(name, { keyPath: "key" });
        store.createIndex("namespace", "namespace", { unique: false });
      }
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close older Contexts tabs and reopen the app to finish the local update. Your pending data has not been removed."));
  });
}
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;
function getChannel() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("mdc-local-storage-v2");
    channel.onmessage = () => { for (const listener of listeners) listener(); };
  }
  return channel;
}
export function changed() { for (const listener of listeners) listener(); getChannel()?.postMessage("changed"); }
export function subscribeLocal(listener: () => void) { getChannel(); listeners.add(listener); return () => { listeners.delete(listener); }; }
