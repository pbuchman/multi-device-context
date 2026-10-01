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
