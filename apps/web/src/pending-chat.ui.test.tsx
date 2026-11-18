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

function workspace(records: ContextRecord[] = [existing]) {
  const account = { projectId: "synthetic-web-pending", uid: crypto.randomUUID() };
  const queue = new DurableOutbox(account);
  outbox = queue;
  let emitContexts!: (next: CloudSnapshot<ContextRecord>) => void;
  const drain = vi.fn(async () => {}); // Network transport is deliberately held; the real outbox remains pending.
  const services: WorkspaceServices = {
    viewer: { uid: "local-audit", name: "QA" }, device, outbox: queue,
    cloud: {
      subscribeContexts: emit => { emitContexts = emit; emit(snapshot(records)); return () => {}; },
      subscribeItems: (_id, emit) => { emit(snapshot([])); return () => {}; },
      renameContext: async () => {}, deleteContext: async () => {}, deleteItem: async () => {}, attachmentBytes: async () => new Uint8Array(),
    },
    copyText: async () => {}, copyFile: async () => {}, saveFile: async () => true, signOut: async () => {}, drain,
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ uiBuild: "dev" })));
  render(<ContextWorkspace services={services} />);
  return { account, queue, drain, emitContexts };
}

async function send(text: string) {
  const field = screen.getByLabelText("Message to yourself");
  fireEvent.change(field, { target: { value: text } });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText(text, { selector: "article .text-card" });
}

it.each([false, true])("keeps a local pending chat selectable across a remote snapshot (fromCache=%s)", async fromCache => {
  const { queue, drain, emitContexts } = workspace();
  await screen.findByRole("button", { name: "Previously synchronized chat" });
  await send("New pending chat");
  await waitFor(() => expect(drain).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "New pending chat" })).toBeTruthy();
  const initialQueue = await queue.list();
  expect(initialQueue).toHaveLength(1);
  const pendingId = initialQueue[0]!.contextId;

  // A latency-compensated cloud echo still has pending writes.
  const echo: ContextRecord = { ...existing, id: pendingId, title: "New pending chat", syncState: "pending" };
  await act(async () => emitContexts({ ...snapshot([existing, echo], true), hasPendingWrites: true }));

  // A normal realtime snapshot contains the synchronized chat but cannot yet include the locally pending creation.
  await act(async () => emitContexts(snapshot([{ ...existing, updatedAt: 2, syncState: fromCache ? "cached" : "synced" }], fromCache)));
  expect((await queue.list()).map(record => record.itemId)).toEqual(initialQueue.map(record => record.itemId));
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

it("removes a never-published chat when another tab deletes its last queued item", async () => {
  const { account, queue, emitContexts } = workspace([]);
  const anotherTab = new DurableOutbox(account);
  try {
    await send("Cross-tab pending chat");
    const [queued] = await queue.list();
    await act(async () => anotherTab.requestDeletion(queued!.contextId, queued!.itemId, true));
    await waitFor(() => expect(screen.queryByText("Cross-tab pending chat", { selector: "article .text-card" })).toBeNull());
    await act(async () => anotherTab.removeItem(queued!.contextId, queued!.itemId));
    expect((await queue.cancelled()).localCreations).toEqual([queued!.contextId]);
    await act(async () => emitContexts(snapshot([])));
    expect(screen.queryByRole("button", { name: "Cross-tab pending chat" })).toBeNull();
    await send("Replacement chat");
    expect((await queue.list())[0]!.contextId).not.toBe(queued!.contextId);
  } finally {
    anotherTab.close();
  }
});

it("keeps a chat with queued siblings while another tab deletes the first item", async () => {
  const { account, queue, emitContexts } = workspace([]);
  const anotherTab = new DurableOutbox(account);
  try {
    await send("Pending chat with siblings");
    await send("Second queued item");
    const [first, second] = await queue.list();
    await act(async () => anotherTab.requestDeletion(first!.contextId, first!.itemId, false));
    await waitFor(() => expect(screen.queryByText("Pending chat with siblings", { selector: "article .text-card" })).toBeNull());
    await act(async () => emitContexts(snapshot([])));
    expect(screen.getByRole("button", { name: "Pending chat with siblings" })).toBeTruthy();
    expect(screen.getByText("Second queued item", { selector: "article .text-card" })).toBeTruthy();
    const [deletion] = await queue.deletions();
    await anotherTab.remove(deletion!.key);
    expect(await queue.list()).toMatchObject([{ itemId: second!.itemId, createsContext: true }]);
  } finally {
    anotherTab.close();
  }
});

it("keeps a published creation until its confirming snapshot arrives", async () => {
  const { queue, emitContexts } = workspace([]);
  await send("Waiting for cloud confirmation");
  const [queued] = await queue.list();
  await act(async () => queue.remove(queued!.key));
  expect(await queue.count()).toBe(0);
  await act(async () => emitContexts(snapshot([])));
  expect(screen.getByRole("button", { name: "Waiting for cloud confirmation" })).toBeTruthy();
  await act(async () => emitContexts(snapshot([{ ...existing, id: queued!.contextId, title: "Confirmed creation" }])));
  expect(screen.getByRole("button", { name: "Confirmed creation" })).toBeTruthy();
});
