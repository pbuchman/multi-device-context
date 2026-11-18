// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { buildServices, ContextWorkspace } from "./App.js";
import { FirebaseCloud, type CloudSnapshot } from "./cloud.js";
import type { ActiveSession } from "./auth.js";
import type { ContextRecord, ItemRecord } from "./model.js";

vi.mock("./history.js", () => ({ prepareHistory: async () => {} }));
vi.mock("firebase/firestore", async original => ({
  ...await original<typeof import("firebase/firestore")>(),
  initializeFirestore: () => ({}),
}));

const contextId = "00000000-0000-4000-8000-000000000001";
const firstId = "00000000-0000-4000-8000-000000000002";
const siblingId = "00000000-0000-4000-8000-000000000003";
const device = { id: "00000000-0000-4000-8000-000000000004", name: "Test browser", platform: "browser", mode: "all", version: 1, createdAt: 1, updatedAt: 1 } as const;
const otherContextId = "00000000-0000-4000-8000-000000000005";
const snapshot = <T,>(records: T[]): CloudSnapshot<T> => ({ records, fromCache: false, hasPendingWrites: false });
const noop = () => () => {};
let dispose: (() => void) | undefined;

afterEach(() => { cleanup(); dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState({}, "", "/"); });

it.each([false, true])("deletes the final chat only with no live sibling (hasSibling=%s)", async hasSibling => {
  let chats: ContextRecord[] = [{ id: contextId, title: "Synthetic sole-message chat", createdAt: 1, updatedAt: 1, syncState: "synced", originDeviceId: device.id }];
  chats.push({ ...chats[0]!, id: otherContextId, title: "Other chat" });
  const firstItem: ItemRecord = { id: firstId, contextId, device, createdAt: 1, ready: true, syncState: "synced", content: { kind: "text", text: "Synthetic first message" } };
  let items = [firstItem, ...(hasSibling ? [{ ...firstItem, id: siblingId, createdAt: 2, content: { kind: "text" as const, text: "Synthetic sibling message" } }] : [])];
  const otherItems: ItemRecord[] = [
    { ...firstItem, contextId: otherContextId, content: { kind: "text", text: "Keep this message in the other chat" } },
    { ...firstItem, contextId: otherContextId, id: siblingId, content: { kind: "text", text: "Control message in the other chat" } },
  ];
  let notifyChats: ((next: CloudSnapshot<ContextRecord>) => void) | undefined;
  let notifyItems: ((next: CloudSnapshot<ItemRecord>) => void) | undefined;
  let notifyDeletedItems: ((items: { contextId: string; itemId: string }[]) => void) | undefined;
  const deleteRequestBodies: Array<string | null> = [];
  const fetchFixture = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), location.origin).pathname;
    if (path === "/api/device") return Response.json(device);
    if (path === "/api/context-origins") return Response.json({ records: [] });
    if (path === `/api/contexts/${contextId}/items/${firstId}` && init?.method === "DELETE") {
      const body = typeof init.body === "string" ? init.body : null;
      deleteRequestBodies.push(body);
      items = items.filter(item => item.id !== firstId);
      notifyItems?.(snapshot(items));
      notifyDeletedItems?.([{ contextId, itemId: firstId }]);
      if (body && JSON.parse(body).deleteEmptyContext && items.length === 0) {
        chats = chats.filter(chat => chat.id !== contextId);
        notifyChats?.(snapshot(chats));
      }
      return new Response(null, { status: 204 });
    }
    return Response.json({ uiBuild: "dev" });
  });
  vi.stubGlobal("fetch", fetchFixture);
  vi.spyOn(FirebaseCloud.prototype, "subscribeDevice").mockImplementation(noop);
  vi.spyOn(FirebaseCloud.prototype, "refreshContexts").mockImplementation(async () => snapshot(chats));
  vi.spyOn(FirebaseCloud.prototype, "subscribeContexts").mockImplementation(emit => { notifyChats = emit; emit(snapshot(chats)); return noop() });
  vi.spyOn(FirebaseCloud.prototype, "subscribeItems").mockImplementation((id, emit) => {
    if (id === contextId) notifyItems = emit;
    emit(snapshot(id === contextId ? items : otherItems));
    return noop();
  });
  vi.spyOn(FirebaseCloud.prototype, "refreshItems").mockImplementation(async id => snapshot(id === contextId ? items : otherItems));
  vi.spyOn(FirebaseCloud.prototype, "deletionMarkers").mockResolvedValue({ contexts: [], items: [] });
  vi.spyOn(FirebaseCloud.prototype, "refreshDeletedContexts").mockResolvedValue([]);
  vi.spyOn(FirebaseCloud.prototype, "refreshDeletedItems").mockResolvedValue([]);
  vi.spyOn(FirebaseCloud.prototype, "subscribeDeletedContexts").mockImplementation(emit => { emit([]); return noop() });
  vi.spyOn(FirebaseCloud.prototype, "subscribeDeletedItems").mockImplementation(emit => {
    notifyDeletedItems = emit;
    emit([]);
    return noop();
  });
  vi.spyOn(FirebaseCloud.prototype, "setNetworkEnabled").mockResolvedValue(undefined);
  const session = {
    device, uid: crypto.randomUUID(), config: { firebase: { projectId: "synthetic-web-audit" }, appOrigin: "https://example.test" },
    firebaseApp: {}, platform: { kind: "browser", dispose() {} }, viewer: { uid: "audit-user", name: "Local QA" },
    accessToken: async () => "synthetic-token", disposeData: async () => {}, signOut: async () => {},
  } as unknown as ActiveSession;
  history.replaceState({}, "", `/contexts/${contextId}`);
  const bundle = await buildServices(session, () => {});
  dispose = bundle.dispose;
  await act(async () => { render(<ContextWorkspace services={bundle.services} />); });
  await screen.findByText("Synthetic first message");
  await userEvent.click(screen.getByRole("button", { name: "Other chat" }));
  await screen.findByText("Keep this message in the other chat");
  await userEvent.click(screen.getByRole("button", { name: "Synthetic sole-message chat" }));
  await screen.findByText("Synthetic first message");
  await userEvent.click(screen.getAllByRole("button", { name: "Delete message" })[0]!);
  await userEvent.click(within(screen.getByRole("dialog", { name: "Delete message?" })).getByRole("button", { name: "Delete message" }));
  await waitFor(() => expect(deleteRequestBodies).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText("Synthetic first message")).toBeNull());
  const chatRow = screen.queryByRole("button", { name: "Synthetic sole-message chat" });
  if (hasSibling) {
    expect(deleteRequestBodies[0]).toBeNull();
    expect(chatRow).toBeTruthy();
    expect(screen.getByText("Synthetic sibling message")).toBeTruthy();
  } else {
    expect.soft(deleteRequestBodies[0]).toBe(JSON.stringify({ deleteEmptyContext: true }));
    expect.soft(Boolean(chatRow)).toBe(false);
  }
  await userEvent.click(screen.getByRole("button", { name: "Other chat" }));
  await screen.findByText("Control message in the other chat");
  expect(screen.queryByText("Keep this message in the other chat")).toBeTruthy();
});
