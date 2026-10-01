// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { DraftStore, emptyDraft } from "./drafts.js";
import { applyLocalAccess } from "./local-access.js";
afterEach(() => localStorage.clear());
it("registers a new recovery context only for an accessible legacy source and keeps foreign histories quarantined", async () => {
  const namespace = `draft-migration:${crypto.randomUUID()}`, device = crypto.randomUUID(), own = crypto.randomUUID(), foreign = crypto.randomUUID();
  const store = new DraftStore(namespace), base = { ...emptyDraft(), local: false };
  await store.save(own, { ...base, text: "Own current" });
  await store.save(foreign, { ...base, text: "Foreign current" });
  await applyLocalAccess(namespace, { id: device, mode: "own", version: 1 }, [own]);
  localStorage.setItem(`mdc-drafts:${namespace}`, JSON.stringify({
    [own]: { ...base, text: "Own older copy" },
    [foreign]: { ...base, text: "Foreign older copy" },
  }));
  await store.migrate();
  expect(Object.values(await store.list()).map(d => d.text).sort()).toEqual(["Own current", "Own older copy"]);
  await applyLocalAccess(namespace, { id: device, mode: "all", version: 2 }, [own]);
  await applyLocalAccess(namespace, { id: device, mode: "own", version: 3 }, [own]);
  expect(Object.values(await store.list()).map(d => d.text).sort()).toEqual(["Own current", "Own older copy"]);
});
