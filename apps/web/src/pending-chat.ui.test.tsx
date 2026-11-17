// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ContextWorkspace, type WorkspaceServices } from "./App.js";
import type { CloudSnapshot } from "./cloud.js";
import { DurableOutbox } from "./outbox.js";
import type { ContextRecord } from "./model.js";

const existingId = "00000000-0000-4000-8000-000000000001";
const device = { id: "00000000-0000-4000-8000-000000000002", name: "Test browser" };
const existing: ContextRecord = { id: existingId, title: "Previously synchronized chat", createdAt: 1, updatedAt: 1, originDeviceId: device.id, syncState: "synced" };
const snapshot = <T,>(records: T[], fromCache = false): CloudSnapshot<T> => ({ records, fromCache, hasPendingWrites: false });
let outbox: DurableOutbox | undefined;

afterEach(() => { cleanup(); outbox?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState({}, "", "/"); });

it.each([false, true])("keeps a local pending chat selectable across a remote snapshot (fromCache=%s)", async fromCache => {
  outbox = new DurableOutbox({ projectId: "synthetic-web-pending", uid: crypto.randomUUID() });
  let emitContexts!: (next: CloudSnapshot<ContextRecord>) => void;
  const drain = vi.fn(async () => {}); // Network transport is deliberately held; the real outbox remains pending.
  const services: WorkspaceServices = {
    viewer: { uid: "local-audit", name: "QA" }, device, outbox,
    cloud: {
      subscribeContexts: emit => { emitContexts = emit; emit(snapshot([existing])); return () => {}; },
      subscribeItems: (_id, emit) => { emit(snapshot([])); return () => {}; },
      renameContext: async () => {}, deleteContext: async () => {}, deleteItem: async () => {}, attachmentBytes: async () => new Uint8Array(),
    },
    copyText: async () => {}, copyFile: async () => {}, saveFile: async () => true, signOut: async () => {}, drain,
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ uiBuild: "dev" })));
  render(<ContextWorkspace services={services} />);
  await screen.findByRole("button", { name: "Previously synchronized chat" });
  const field = screen.getByLabelText("Message to yourself");
  fireEvent.change(field, { target: { value: "New pending chat" } });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("New pending chat", { selector: "article .text-card" });
  await waitFor(() => expect(drain).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "New pending chat" })).toBeTruthy();
  const initialQueue = await outbox.list();
  expect(initialQueue).toHaveLength(1);
  const pendingId = initialQueue[0]!.contextId;

  // A latency-compensated cloud echo still has pending writes.
  const echo: ContextRecord = { ...existing, id: pendingId, title: "New pending chat", syncState: "pending" };
  await act(async () => emitContexts({ ...snapshot([existing, echo], true), hasPendingWrites: true }));

  // A normal realtime snapshot contains the synchronized chat but cannot yet include the locally pending creation.
  await act(async () => emitContexts(snapshot([{ ...existing, updatedAt: 2, syncState: fromCache ? "cached" : "synced" }], fromCache)));
  expect((await outbox.list()).map(record => record.itemId)).toEqual(initialQueue.map(record => record.itemId));
  expect.soft(screen.queryByRole("button", { name: "New pending chat" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Previously synchronized chat" }));
  const pending = screen.queryByRole("button", { name: "New pending chat" });
  expect.soft(pending).toBeTruthy();
  if (pending) {
    await userEvent.click(pending);
    expect(screen.getByText("New pending chat", { selector: "article .text-card" })).toBeTruthy();
  }

  await act(async () => emitContexts(snapshot([existing, { ...echo, title: "Confirmed chat", syncState: "synced" }])));
  expect(screen.getByRole("button", { name: "Confirmed chat" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New pending chat" })).toBeNull();
  await act(async () => emitContexts(snapshot([existing])));
  expect(screen.queryByRole("button", { name: "Confirmed chat" })).toBeNull();
});
