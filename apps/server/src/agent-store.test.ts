import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { AgentStore, decodeCursor } from "./agent-store.js";

type Data = Record<string, any>;
const uid = "owner";
const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const deviceA = uuid(1), deviceB = uuid(2);
const timestamp = (seconds: number, nanoseconds = 0) => new Timestamp(seconds, nanoseconds);
const compare = (a: any, b: any): number => a instanceof Timestamp && b instanceof Timestamp ? a.seconds - b.seconds || a.nanoseconds - b.nanoseconds : a < b ? -1 : a > b ? 1 : 0;
const field = (data: Data, name: string) => name.split(".").reduce((value, key) => value?.[key], data);
class Database {
  documents = new Map<string, Data>();
  doc(path: string): any {
    const ref = { path, id: path.split("/").at(-1), collection: (name: string) => this.collection(`${path}/${name}`), get: async () => ({ id: ref.id, ref, exists: this.documents.has(path), data: () => this.documents.get(path) }) };
    return ref;
  }
  collection(path: string, filters: [string, unknown][] = [], orders: [string, string][] = [], cursor?: any[], maximum = Infinity): any {
    const query = {
      doc: (id: string) => this.doc(`${path}/${id}`),
      where: (name: string, _op: string, value: unknown) => this.collection(path, [...filters, [name, value]], orders, cursor, maximum),
      orderBy: (name: unknown, direction = "asc") => this.collection(path, filters, [...orders, [typeof name === "string" ? name : "__name__", direction]], cursor, maximum),
      startAfter: (...value: any[]) => this.collection(path, filters, orders, value, maximum),
      limit: (n: number) => this.collection(path, filters, orders, cursor, n),
      get: async () => {
        let entries = [...this.documents].filter(([key, data]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/") && filters.every(([name, value]) => field(data, name) === value));
        const value = ([key, data]: [string, Data], name: string) => name === "__name__" ? key.split("/").at(-1) : field(data, name);
        entries.sort((a, b) => { for (const [name, direction] of orders) { const n = compare(value(a, name), value(b, name)) * (direction === "desc" ? -1 : 1); if (n) return n; } return 0; });
        if (cursor) entries = entries.filter(entry => { for (const [index, [name, direction]] of orders.entries()) { const n = compare(value(entry, name), cursor[index]) * (direction === "desc" ? -1 : 1); if (n) return n > 0; } return false; });
        const docs = await Promise.all(entries.slice(0, maximum).map(([key]) => this.doc(key).get()));
        return { docs, size: docs.length };
      },
    };
    return query;
  }
}
function fixture() {
  const db = new Database();
  const store = new AgentStore(db as never, {} as never, {} as never);
  const context = (id: string, data: Data = {}, owner = uid) => {
    const path = `users/${owner}/contexts/${id}`;
    db.documents.set(path, { title: "Synthetic", originDeviceId: deviceA, createdAt: timestamp(1), updatedAt: timestamp(1), deleting: false, ...data });
    return path;
  };
  const item = (path: string, id: string, device: { id: string; name: string }, data: Data = {}) => db.documents.set(`${path}/items/${id}`, { device, createdAt: timestamp(1), deleting: false, content: { kind: "text", text: "Immutable history" }, ...data });
  return { db, store, context, item };
}

describe("agent context origin queries", () => {
  it("filters origins before limiting and keeps other-owner and deleted records out", async () => {
    const f = fixture(); f.context(uuid(10), { originDeviceId: deviceB });
    f.context(uuid(11), { originDeviceId: deviceA, createdAt: timestamp(2) });
    f.context(uuid(12), { originDeviceId: deviceA, createdAt: timestamp(3) });
    f.context(uuid(13), { originDeviceId: deviceA, createdAt: timestamp(4), deleting: true });
    f.context(uuid(14), { originDeviceId: deviceA, createdAt: timestamp(5) }, "other");
    const first = await f.store.listContexts(uid, undefined, 1, { deviceId: deviceA });
    expect(first.records.map(record => record.id)).toEqual([uuid(11)]);
    const next = await f.store.listContexts(uid, first.cursor!, 1, { deviceId: deviceA });
    expect(next.records.map(record => record.id)).toEqual([uuid(12)]);
    expect((await f.store.listContexts(uid, next.cursor!, 1, { deviceId: deviceA })).records).toEqual([]);
  });
  it("orders equal timestamps by UUID without losing nanosecond cursor precision in either direction", async () => {
    const f = fixture();
    for (const id of [uuid(22), uuid(20), uuid(21)]) f.context(id, { createdAt: timestamp(2, 123456789) });
    f.context(uuid(19), { createdAt: timestamp(2, 123456790) });
    for (const order of ["asc", "desc"] as const) {
      const ids: string[] = []; let after: string | undefined;
      for (let n = 0; n < 5; n++) {
        const page = await f.store.listContexts(uid, after, 1, { order });
        ids.push(...page.records.map(record => record.id));
        if (!page.records.length) break;
        after = page.cursor!;
      }
      expect(ids).toEqual(order === "asc" ? [uuid(20), uuid(21), uuid(22), uuid(19)] : [uuid(19), uuid(22), uuid(21), uuid(20)]);
    }
    const page = await f.store.listContexts(uid, undefined, 1);
    expect(decodeCursor(page.cursor!)[0]).toEqual(timestamp(2, 123456789));
  });
  it("selects latest by context creation and immutable origin despite newer appended messages", async () => {
    const f = fixture(); f.context(uuid(30), { createdAt: timestamp(1), updatedAt: timestamp(100) });
    const newest = f.context(uuid(31), { createdAt: timestamp(2), updatedAt: timestamp(2) });
    f.item(newest, uuid(40), { id: deviceB, name: "Other sender" });
    expect((await f.store.listContexts(uid, undefined, 1, { deviceId: deviceA, order: "desc" })).records[0]?.id).toBe(uuid(31));
    expect((await f.store.listContexts(uid, undefined, 1, { deviceId: deviceB, order: "desc" })).records).toEqual([]);
  });
});

describe("agent device discovery", () => {
  it("prefers registered aliases, discovers legacy origins and keeps historical content immutable", async () => {
    const f = fixture();
    f.db.documents.set(`users/${uid}/devices/${deviceA}`, { name: "Renamed MacBook", mode: "all", version: 8, credential: "never-export" });
    f.db.documents.set(`users/other/devices/${uuid(9)}`, { name: "Other owner" });
    const existing = f.context(uuid(50), { firstItemId: uuid(60) }); f.item(existing, uuid(60), { id: deviceA, name: "Old MacBook" });
    const legacy = f.context(uuid(51), { originDeviceId: deviceB, firstItemId: uuid(61) }); f.item(legacy, uuid(61), { id: deviceB, name: "Łódź Radio" });
    const preOrigin = f.context(uuid(52)); delete f.db.documents.get(preOrigin)!.originDeviceId;
    f.item(preOrigin, uuid(62), { id: uuid(3), name: "Legacy phone" });
    const before = JSON.stringify([...f.db.documents]);
    expect(await f.store.listDevices(uid)).toEqual({ records: [
      { id: deviceA, name: "Renamed MacBook" }, { id: deviceB, name: "Łódź Radio" },
    ] });
    expect(JSON.stringify([...f.db.documents])).toBe(before);
  });
  it("uses origin-matching snapshots when a promoted first item belongs to a different installation", async () => {
    const f = fixture(); const path = f.context(uuid(70), { firstItemId: uuid(80) });
    f.item(path, uuid(80), { id: deviceB, name: "Appended phone" }, { createdAt: timestamp(2) });
    f.item(path, uuid(81), { id: deviceA, name: "Original MacBook" }, { createdAt: timestamp(1) });
    expect(await f.store.listDevices(uid)).toEqual({ records: [{ id: deviceA, name: "Original MacBook" }] });
  });
  it("excludes deleted contexts and items and ignores invalid historical device metadata", async () => {
    const f = fixture(); const deleted = f.context(uuid(90), { deleting: true, firstItemId: uuid(91) });
    f.item(deleted, uuid(91), { id: deviceA, name: "Deleted" });
    const deadItem = f.context(uuid(92)); delete f.db.documents.get(deadItem)!.originDeviceId;
    f.item(deadItem, uuid(93), { id: deviceB, name: "Deleted item" }, { deleting: true });
    const invalid = f.context(uuid(94)); delete f.db.documents.get(invalid)!.originDeviceId;
    f.item(invalid, uuid(95), { id: "not-a-uuid", name: "Bad" });
    expect(await f.store.listDevices(uid)).toEqual({ records: [] });
  });
  it("uses UUID metadata when an immutable origin has no surviving valid snapshot", async () => {
    const f = fixture(); const path = f.context(uuid(96), { firstItemId: uuid(97) });
    f.item(path, uuid(97), { id: deviceA, name: "Deleted original" }, { deleting: true });
    f.item(path, uuid(98), { id: deviceB, name: "New sender" });
    expect(await f.store.listDevices(uid)).toEqual({ records: [{ id: deviceA, name: deviceA }] });
  });
  it("does not truncate registered devices or context-origin discovery at 100 records", async () => {
    const f = fixture();
    for (let n = 100; n < 205; n++) {
      f.db.documents.set(`users/${uid}/devices/${uuid(n)}`, { name: `Registered ${n}` });
      const path = f.context(uuid(n + 1000), { originDeviceId: uuid(n + 2000), firstItemId: uuid(n + 3000) });
      f.item(path, uuid(n + 3000), { id: uuid(n + 2000), name: `Legacy ${n}` });
    }
    expect((await f.store.listDevices(uid)).records).toHaveLength(210);
  });
});
