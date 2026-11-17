// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import { DraftStore, emptyDraft } from "./drafts.js";
import { DurableOutbox } from "./outbox.js";
import type { ContextRecord } from "./model.js";

const contextId = "00000000-0000-4000-8000-000000000001";
const device = { id: "00000000-0000-4000-8000-000000000002", name: "Test browser" };
const chat: ContextRecord = { id: contextId, title: "Synthetic chat", createdAt: 1, updatedAt: 1, originDeviceId: device.id, syncState: "synced" };
const snapshot = <T,>(records: T[]) => ({ records, fromCache: false, hasPendingWrites: false });
let outbox: DurableOutbox | undefined;

afterEach(() => { cleanup(); outbox?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each([false, true])("preserves newer text across an older failed draft write (latest edit fails=%s)", async latestFails => {
  outbox = new DurableOutbox({ projectId: "web-draft-retry-probe", uid: crypto.randomUUID() });
  const store = new DraftStore(outbox.namespace);
  await store.save(contextId, { ...emptyDraft(), local: false, text: "Previously saved" });
  const services: WorkspaceServices = {
    viewer: { uid: "local-audit", name: "QA" }, device, outbox, initialContextId: contextId,
    cloud: {
      subscribeContexts: emit => { emit(snapshot([chat])); return () => {}; },
      subscribeItems: (_id, emit) => { emit(snapshot([])); return () => {}; },
      renameContext: async () => {}, deleteContext: async () => {}, deleteItem: async () => {}, attachmentBytes: async () => new Uint8Array(),
    },
    copyText: async () => {}, copyFile: async () => {}, saveFile: async () => true, signOut: async () => {}, drain: async () => {},
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ uiBuild: "dev" })));
  render(<ContextWorkspace services={services} />);
  const field = screen.getByLabelText("Message to yourself") as HTMLTextAreaElement;
  await waitFor(() => expect(field.value).toBe("Previously saved"));

  const reads = vi.spyOn(DraftStore.prototype, "isRemoved");
  const queueRetry = vi.spyOn(outbox, "retry");
  const writes = vi.spyOn(DraftStore.prototype, "save").mockRejectedValueOnce(new DOMException("Transient local storage failure", "QuotaExceededError"));
  fireEvent.change(field, { target: { value: "Edit affected by one failed save" } });
  await screen.findByText("Your draft could not be saved locally. Keep this tab open and retry.");
  await waitFor(() => expect(reads).toHaveBeenCalled());
  await act(async () => { await reads.mock.results.at(-1)?.value; });
  expect.soft(field.value).toBe("Edit affected by one failed save");

  const readsBeforeLatest = reads.mock.calls.length;
  if (latestFails) writes.mockRejectedValueOnce(new DOMException("Transient local storage failure", "QuotaExceededError"));
  fireEvent.change(field, { target: { value: "My latest draft" } });
  await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(readsBeforeLatest));
  await act(async () => { await reads.mock.results.at(-1)?.value; });
  expect.soft(field.value).toBe("My latest draft");
  if (latestFails) expect(await store.list()).toMatchObject({ [contextId]: { text: "Previously saved" } });
  const retryButton = screen.queryByRole("button", { name: "Retry" });
  if (latestFails) expect(retryButton).toBeTruthy();
  if (retryButton) {
    const readsBeforeRetry = reads.mock.calls.length;
    const writesBeforeRetry = writes.mock.calls.length;
    await userEvent.click(retryButton);
    await waitFor(() => expect(queueRetry).toHaveBeenCalled());
    await act(async () => { await queueRetry.mock.results.at(-1)?.value; });
    if (writes.mock.calls.length > writesBeforeRetry) {
      await act(async () => { await writes.mock.results.at(-1)?.value; });
      await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(readsBeforeRetry));
      await act(async () => { await reads.mock.results.at(-1)?.value; });
    }
  }
  expect.soft((await store.list())[contextId]?.text).toBe("My latest draft");
  expect.soft(field.value).toBe("My latest draft");
});
