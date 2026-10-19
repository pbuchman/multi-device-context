import { describe, expect, it } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { AgentStore, decodeCursor } from "./agent-store.js";
import { BackendNotFoundError } from "./backend-errors.js";

type Data = Record<string, any>;
const uid = "owner";
const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const deviceA = uuid(1), deviceB = uuid(2);
const timestamp = (seconds: number, nanoseconds = 0) => new Timestamp(seconds, nanoseconds);
const compare = (a: any, b: any): number => a instanceof Timestamp && b instanceof Timestamp ? a.seconds - b.seconds || a.nanoseconds - b.nanoseconds : a < b ? -1 : a > b ? 1 : 0;
const field = (data: Data, name: string) => name.split(".").reduce((value, key) => value?.[key], data);
class Database {
  documents = new Map<string, Data>();
  writes = 0;
  async runTransaction(work: (tx: any) => unknown) {
    return work({ get: (ref: any) => ref.get(), update: (ref: any, update: Data) => {
      this.writes++;
      const resolved = Object.fromEntries(Object.entries(update).map(([key, value]) => [key, value instanceof FieldValue && value.isEqual(FieldValue.serverTimestamp()) ? timestamp(1000, this.writes) : value]));
      this.documents.set(ref.path, { ...this.documents.get(ref.path), ...resolved });
    } });
  }
  doc(path: string): any {
    const ref = { path, id: path.split("/").at(-1), collection: (name: string) => this.collection(`${path}/${name}`), get: async () => ({ id: ref.id, ref, exists: this.documents.has(path), data: () => this.documents.get(path) }) };
    return ref;
  }
  collection(path: string, filters: [string, string, unknown][] = [], orders: [string, string][] = [], cursor?: any[], maximum = Infinity): any {
    const query = {
      doc: (id: string) => this.doc(`${path}/${id}`),
      where: (name: string, op: string, value: unknown) => this.collection(path, [...filters, [name, op, value]], orders, cursor, maximum),
      orderBy: (name: unknown, direction = "asc") => this.collection(path, filters, [...orders, [typeof name === "string" ? name : "__name__", direction]], cursor, maximum),
      startAfter: (...value: any[]) => this.collection(path, filters, orders, value, maximum),
      limit: (n: number) => this.collection(path, filters, orders, cursor, n),
      get: async () => {
        let entries = [...this.documents].filter(([key, data]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/") && filters.every(([name, op, value]) => op === "!=" ? field(data, name) !== undefined && field(data, name) !== value : field(data, name) === value));
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

describe("account context pins", () => {
  it("serializes legacy contexts as unpinned without adding context fields to items", async () => {
    const f = fixture(); const path = f.context(uuid(400)); f.item(path, uuid(401), { id: deviceA, name: "Phone" });
    expect(await f.store.getContext(uid, uuid(400))).toMatchObject({ pinned: false, pinnedAt: null });
    expect((await f.store.listContexts(uid)).records[0]).toMatchObject({ pinned: false, pinnedAt: null });
    const entry = (await f.store.listItems(uid, uuid(400))).records[0];
    expect(entry).not.toHaveProperty("pinned"); expect(entry).not.toHaveProperty("pinnedAt");
  });
  it("pins idempotently, leaves activity alone, and combines title/pin updates atomically", async () => {
    const f = fixture(); const path = f.context(uuid(410));
    const original = f.db.documents.get(path)!.updatedAt;
    const first = await f.store.updateContext(uid, uuid(410), { pinned: true });
    expect(first).toMatchObject({ pinned: true, pinnedAt: 1000000.000001 });
    const stamp = f.db.documents.get(path)!.pinnedAt;
    await f.store.updateContext(uid, uuid(410), { pinned: true });
    expect(f.db.writes).toBe(1); expect(f.db.documents.get(path)!.pinnedAt).toEqual(stamp);
    expect(f.db.documents.get(path)!.updatedAt).toEqual(original);
    await f.store.updateContext(uid, uuid(410), { title: "Manual", pinned: false });
    expect(f.db.writes).toBe(2);
    expect(f.db.documents.get(path)).toMatchObject({ title: "Manual", titleState: "manual", pinnedAt: null });
    expect(f.db.documents.get(path)!.updatedAt).not.toEqual(original);
    await f.store.updateContext(uid, uuid(410), { pinned: false }); expect(f.db.writes).toBe(2);
    await expect(f.store.updateContext("other", uuid(410), { pinned: true })).rejects.toBeInstanceOf(BackendNotFoundError);
    f.db.documents.get(path)!.deleting = true;
    await expect(f.store.updateContext(uid, uuid(410), { title: "No resurrection", pinned: true })).rejects.toBeInstanceOf(BackendNotFoundError);
    expect(f.db.writes).toBe(2);
  });
  it("finds old pins outside ordinary pages and fills the unpinned phase across skipped pages", async () => {
    const f = fixture();
    for (let n = 500; n < 625; n++) f.context(uuid(n), { createdAt: timestamp(1, n), pinnedAt: n < 560 ? timestamp(10 + n) : null });
    f.context(uuid(700), { createdAt: timestamp(100), pinnedAt: timestamp(1000) });
    f.context(uuid(701), { createdAt: timestamp(100), pinnedAt: timestamp(1000) });
    f.context(uuid(702), { originDeviceId: deviceB, pinnedAt: timestamp(30) });
    f.context(uuid(703), { deleting: true, pinnedAt: timestamp(40) });
    for (const order of ["asc", "desc"] as const) {
      let after: string | undefined; const records: string[] = [];
      for (let i = 0; i < 20; i++) {
        const page = await f.store.listContexts(uid, after, 9, { sort: "pinned", deviceId: deviceA, order });
        records.push(...page.records.map(r => r.id)); after = page.cursor!;
        if (!page.hasMore) break;
      }
      const pins = [uuid(700), uuid(701), ...Array.from({ length: 60 }, (_, n) => uuid(559 - n))];
      const unpinned = Array.from({ length: 65 }, (_, n) => uuid(order === "asc" ? 560 + n : 624 - n));
      expect(records).toEqual([...pins, ...unpinned]);
      expect(new Set(records).size).toBe(records.length);
    }
  });
  it("filters only real pins, supports creation sorting, and binds new cursors to every query option", async () => {
    const f = fixture();
    f.context(uuid(800), { createdAt: timestamp(2, 123456789), pinnedAt: timestamp(8) });
    f.context(uuid(801), { createdAt: timestamp(2, 123456790), pinnedAt: timestamp(7) });
    f.context(uuid(802), { pinnedAt: null }); f.context(uuid(803));
    const first = await f.store.listContexts(uid, undefined, 1, { pinned: true });
    expect(first.records[0]?.id).toBe(uuid(800));
    expect(JSON.parse(Buffer.from(first.cursor!, "base64url").toString()).position).toEqual([2, 123456789, uuid(800)]);
    const next = await f.store.listContexts(uid, first.cursor!, 1, { pinned: true });
    expect(next.records.map(r => r.id)).toEqual([uuid(801)]); expect(next.hasMore).toBe(false);
    for (const options of [{ sort: "pinned" as const, pinned: true as const }, { pinned: true as const, order: "desc" as const }, { pinned: true as const, deviceId: deviceB }, {}]) {
      await expect(f.store.listContexts(uid, first.cursor!, 1, options)).rejects.toMatchObject({ statusCode: 400 });
    }
    const legacy = await f.store.listContexts(uid, undefined, 1);
    await expect(f.store.listContexts(uid, legacy.cursor!, 1, { sort: "pinned" })).rejects.toMatchObject({ statusCode: 400 });
    for (const after of ["bad", Buffer.from(JSON.stringify({ version: 1 })).toString("base64url")]) {
      await expect(f.store.listContexts(uid, after, 1, { sort: "pinned" })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect((await f.store.listContexts(uid, undefined, 10, { sort: "pinned", pinned: true })).records.map(r => r.id)).toEqual([uuid(800), uuid(801)]);
  });
  it("keeps chronological latest and watch tuples independent of account pins", async () => {
    const f = fixture(); f.context(uuid(900), { createdAt: timestamp(1), pinnedAt: timestamp(50) });
    f.context(uuid(901), { createdAt: timestamp(2, 999999999) });
    const watch = await f.store.listContexts(uid, undefined, 1);
    expect(watch.records[0]?.id).toBe(uuid(900)); expect(decodeCursor(watch.cursor!)[0]).toEqual(timestamp(1));
    expect((await f.store.listContexts(uid, watch.cursor!, 1)).records[0]?.id).toBe(uuid(901));
    expect((await f.store.listContexts(uid, undefined, 1, { order: "desc" })).records[0]?.id).toBe(uuid(901));
  });
  it("preserves browser fractional pin milliseconds in serialization, ordering and cursor seeks", async () => {
    const f = fixture();
    f.context(uuid(910), { pinnedAt: timestamp(1000, 1000) });
    f.context(uuid(911), { pinnedAt: timestamp(1000, 500000) });
    const first = await f.store.listContexts(uid, undefined, 1, { sort: "pinned" });
    expect(first.records[0]).toMatchObject({ id: uuid(911), pinnedAt: 1000000.5 });
    expect(JSON.parse(Buffer.from(first.cursor!, "base64url").toString()).position).toEqual([1000, 500000, uuid(911)]);
    const next = await f.store.listContexts(uid, first.cursor!, 1, { sort: "pinned" });
    expect(next.records[0]).toMatchObject({ id: uuid(910), pinnedAt: 1000000.001 });
    expect(next.hasMore).toBe(false);
  });
});
