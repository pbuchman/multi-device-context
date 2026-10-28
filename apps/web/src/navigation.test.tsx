// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DraftStore, emptyDraft } from "./drafts.js";
import { changed } from "./local-db.js";
import { useNavigation } from "./navigation.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); history.replaceState({}, "", "/"); });

it("ignores an older reload after a named local chat has been saved and deselected", async () => {
  vi.spyOn(DraftStore.prototype, "isRemoved").mockResolvedValue(false);
  const namespace = `navigation-race:${crypto.randomUUID()}`;
  const view = renderHook(() => useNavigation(namespace));
  await act(async () => view.result.current.flush());
  const renamedId = view.result.current.selectedId;
  let releaseOld!: () => void;
  let markStarted!: () => void;
  const oldRead = new Promise<void>(resolve => { releaseOld = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  vi.spyOn(DraftStore.prototype, "list").mockImplementationOnce(async () => {
    markStarted(); await oldRead; return {};
  });

  act(() => changed());
  await started;
  act(() => { view.result.current.patch({ title: "Next trip" }); view.result.current.select(); });
  await act(async () => view.result.current.flush());
  expect(view.result.current.localContexts).toEqual([expect.objectContaining({ id: renamedId, title: "Next trip" })]);

  await act(async () => { releaseOld(); await oldRead; });
  expect(view.result.current.localContexts).toEqual([expect.objectContaining({ id: renamedId, title: "Next trip" })]);
  expect((await new DraftStore(namespace).list())[renamedId]?.title).toBe("Next trip");
});

it("does not let an unmounted navigation reload replace the next workspace's URL", async () => {
  const namespace = `navigation-unmount:${crypto.randomUUID()}`, nextId = crypto.randomUUID();
  let releaseRead!: () => void, markReadStarted!: () => void;
  const pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
  vi.spyOn(DraftStore.prototype, "list").mockImplementationOnce(async () => {
    markReadStarted(); await pendingRead; return {};
  });
  vi.spyOn(DraftStore.prototype, "isRemoved").mockResolvedValue(true);
  const view = renderHook(() => useNavigation(namespace));
  await readStarted;
  const flush = view.result.current.flush();
  view.unmount();
  history.replaceState({}, "", `/contexts/${nextId}`);
  releaseRead(); await flush;
  expect(location.pathname).toBe(`/contexts/${nextId}`);
});

it("finishes a draft write accepted before unmount without reloading the old navigation", async () => {
  const namespace = `navigation-save-unmount:${crypto.randomUUID()}`;
  const view = renderHook(() => useNavigation(namespace));
  await act(async () => view.result.current.flush());
  const id = view.result.current.selectedId;
  let releaseSave!: () => void, markSaveStarted!: () => void;
  const pendingSave = new Promise<void>(resolve => { releaseSave = resolve; });
  const saveStarted = new Promise<void>(resolve => { markSaveStarted = resolve; });
  const originalSave = DraftStore.prototype.save;
  vi.spyOn(DraftStore.prototype, "save").mockImplementation(async function (this: DraftStore, target, draft) {
    markSaveStarted(); await pendingSave; return originalSave.call(this, target, draft);
  });
  act(() => view.result.current.patch({ text: "Keep this accepted draft" }));
  const flush = view.result.current.flush();
  await saveStarted; view.unmount(); releaseSave(); await flush;
  expect((await new DraftStore(namespace).list())[id]?.text).toBe("Keep this accepted draft");
});

it("does not reload the old namespace when its migration completes after workspace replacement", async () => {
  const previous = `navigation-previous:${crypto.randomUUID()}`, next = `navigation-next:${crypto.randomUUID()}`;
  const nextId = crypto.randomUUID();
  let releaseMigration!: () => void, markMigrationStarted!: () => void;
  const pendingMigration = new Promise<void>(resolve => { releaseMigration = resolve; });
  const migrationStarted = new Promise<void>(resolve => { markMigrationStarted = resolve; });
  vi.spyOn(DraftStore.prototype, "migrate").mockImplementationOnce(async () => { markMigrationStarted(); await pendingMigration; });
  const oldRead = vi.spyOn(DraftStore.prototype, "list");
  vi.spyOn(DraftStore.prototype, "isRemoved").mockImplementation(async function (this: DraftStore) { return this.namespace === previous; });
  const view = renderHook(({ namespace }) => useNavigation(namespace), { initialProps: { namespace: previous } });
  await migrationStarted;
  view.rerender({ namespace: next });
  history.replaceState({}, "", `/contexts/${nextId}`);
  const flush = view.result.current.flush();
  await act(async () => { releaseMigration(); await flush; });
  const readNamespaces = oldRead.mock.contexts.map(store => store instanceof DraftStore ? store.namespace : undefined);
  expect(readNamespaces).not.toContain(previous);
  expect(readNamespaces).toContain(next);
  expect(location.pathname).toBe(`/contexts/${nextId}`);
  view.unmount();
});


it("restores saved drafts after StrictMode's effect replay", async () => {
  const namespace = `navigation-strict:${crypto.randomUUID()}`, id = crypto.randomUUID();
  await new DraftStore(namespace).save(id, { ...emptyDraft(), text: "Saved before replay", local: false });
  const view = renderHook(() => useNavigation(namespace, id), { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> });
  await act(async () => view.result.current.flush());
  expect(view.result.current.text).toBe("Saved before replay");
});

it("settles queued initialization after the unmounted browser environment is gone", async () => {
  const namespace = `navigation-environment-teardown:${crypto.randomUUID()}`;
  let releaseMigration!: () => void, markMigrationStarted!: () => void;
  const pendingMigration = new Promise<void>(resolve => { releaseMigration = resolve; });
  const migrationStarted = new Promise<void>(resolve => { markMigrationStarted = resolve; });
  vi.spyOn(DraftStore.prototype, "migrate").mockImplementationOnce(async () => { markMigrationStarted(); await pendingMigration; });
  const view = renderHook(() => useNavigation(namespace));
  await migrationStarted;
  const flush = view.result.current.flush(); view.unmount();
  vi.stubGlobal("window", undefined);
  try {
    releaseMigration();
    await expect(flush).resolves.toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});
