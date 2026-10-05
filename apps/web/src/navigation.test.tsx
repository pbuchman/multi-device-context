// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DraftStore } from "./drafts.js";
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
