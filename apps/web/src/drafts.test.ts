import { beforeEach, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DraftStore, emptyDraft } from "./drafts.js";
const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
it("R3: independent tabs preserve both drafts after reopening", async () => {
  const first = new DraftStore("test:user"), second = new DraftStore("test:user");
  await first.save(a, { ...emptyDraft(), text: "Draft A" });
  await second.save(b, { ...emptyDraft(), text: "Draft B" });
  const rows = await new DraftStore("test:user").list();
  expect(rows[a]?.text).toBe("Draft A"); expect(rows[b]?.text).toBe("Draft B");
});
it("R3: concurrent edits preserve both versions and deletion beats a stale writer", async () => {
  const first = new DraftStore("test:user"), second = new DraftStore("test:user");
  await first.save(a, { ...emptyDraft(), text: "Version A" });
  expect(await second.save(a, { ...emptyDraft(), text: "Version B" })).toBe(true);
  expect(Object.values(await first.list()).map(d => d.text).sort()).toEqual(["Version A", "Version B"]);
  await first.remove([a]); await second.save(a, { ...emptyDraft(), text: "Stale" });
  expect((await first.list())[a]).toBeUndefined();
});

it("keeps both writers visible in own mode and preserves recovered local work after an access downgrade", async () => {
  const { applyLocalAccess } = await import("./local-access.js");
  const namespace = "test:own-recovery", device = crypto.randomUUID();
  await applyLocalAccess(namespace, { id: device, mode: "own", version: 1 }, [a]);
  const first = new DraftStore(namespace), second = new DraftStore(namespace);
  const base = { ...emptyDraft(), local: false };
  await first.save(a, { ...base, text: "First writer" });
  expect(await second.save(a, { ...base, text: "Second writer" })).toBe(true);
  expect(Object.values(await second.list()).map(d => d.text).sort()).toEqual(["First writer", "Second writer"]);
  await applyLocalAccess(namespace, { id: device, mode: "all", version: 2 }, [a]);
  await applyLocalAccess(namespace, { id: device, mode: "own", version: 3 }, [a]);
  expect(Object.values(await new DraftStore(namespace).list()).map(d => d.text).sort()).toEqual(["First writer", "Second writer"]);
});

it("rolls back recovery provenance together with the draft when saving the recovered copy fails", async () => {
  const { applyLocalAccess, readLocalAccess } = await import("./local-access.js");
  const { vi } = await import("vitest");
  const namespace = "test:recovery-atomic", device = crypto.randomUUID();
  await applyLocalAccess(namespace, { id: device, mode: "own", version: 1 }, [a]);
  const first = new DraftStore(namespace), second = new DraftStore(namespace), base = { ...emptyDraft(), local: false };
  await first.save(a, { ...base, text: "First writer" });
  const original = IDBObjectStore.prototype.put;
  const failing = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if ((value as { title?: string }).title === "Recovered draft") throw new DOMException("Storage rejected recovery", "DataCloneError");
    return original.call(this, value, key);
  });
  try { await expect(second.save(a, { ...base, text: "Second writer" })).rejects.toThrow("Storage rejected recovery"); }
  finally { failing.mockRestore(); }
  expect(Object.values(await first.list()).map(d => d.text)).toEqual(["First writer"]);
  expect((await readLocalAccess(namespace))?.own).toEqual([a]);
});
