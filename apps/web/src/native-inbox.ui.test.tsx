// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActiveSession } from "./auth.js";
import { createAndroidAdapter, type MdcNativePlugin } from "./android.js";
import { DraftStore, emptyDraft } from "./drafts.js";
import { DurableOutbox } from "./outbox.js";

const state = vi.hoisted(() => ({
  active: undefined as ActiveSession | undefined,
  device: { id: "11111111-1111-4111-8111-111111111111", name: "Synthetic phone",
    platform: "android" as const, mode: "all" as const, version: 1, createdAt: 1, updatedAt: 1 },
  contexts: { records: [], fromCache: false, hasPendingWrites: false },
  publish: vi.fn(async () => {}),
}));
vi.mock("./history.js", () => ({ prepareHistory: async () => {} }));
vi.mock("./auth.js", () => ({
  SessionManager: class {
    async prepare() {}
    async restore() { return state.active; }
  },
}));
vi.mock("./cloud.js", () => ({
  FirebaseCloud: class {
    async refreshDevice() { return state.device; }
    async refreshContexts() { return state.contexts; }
    async refreshDeletedContexts() { return []; }
    async refreshDeletedItems() { return []; }
    async refreshItems() { return state.contexts; }
    async getSettings() { return { aiTitlesEnabled: false }; }
    async setNetworkEnabled() {}
    subscribeDevice() { return () => {}; }
    subscribeContexts() { return () => {}; }
    subscribeItems() { return () => {}; }
    publish = state.publish;
    async deleteContext() {}
    async deleteItem() {}
    async deletionMarkers() { return { contexts: [], items: [] }; }
    invalidate() {}
  },
}));
import App from "./App.js";

afterEach(() => { cleanup(); localStorage.clear(); });

it("keeps the workspace open and publishes healthy native shares around an unreadable batch", async () => {
  const draftId = "22222222-2222-4222-8222-222222222222";
  const draftText = "Unsent synthetic note";
  const first = "33333333-3333-4333-8333-333333333333";
  const unreadable = "44444444-4444-4444-8444-444444444444";
  const last = "55555555-5555-4555-8555-555555555555";
  const requests = [
    { id: first, capturedAt: 1, text: "First queued text", files: [] },
    { id: unreadable, capturedAt: 2, text: "Unavailable attachment batch", files: [
      { id: "66666666-6666-4666-8666-666666666666", name: "fixture.bin", contentType: "application/octet-stream",
        path: "file:///data/user/0/com.multidevicecontext.mobile/files/inbox/fixture", size: 3 },
    ] },
    { id: last, capturedAt: 3, text: "Last queued text", files: [] },
  ];
  const projectId = "native-inbox-test", uid = crypto.randomUUID();
  const outbox = new DurableOutbox({ projectId, uid });
  const drafts = new DraftStore(outbox.namespace);
  await drafts.save(draftId, { ...emptyDraft(), title: "Existing local draft", text: draftText });
  const acknowledged: string[] = [];
  const storedWhenAcknowledged: boolean[] = [];
  const listener = async () => ({ remove: async () => {} });
  const plugin = {
    addListener: listener,
    getPendingShares: async () => ({ requests: requests.filter(request => !acknowledged.includes(request.id)) }),
    acknowledgeShare: async ({ id }: { id: string }) => {
      storedWhenAcknowledged.push(await outbox.hasNativeRequest(id));
      acknowledged.push(id);
    },
    takeNavigation: async () => ({}),
  } as unknown as MdcNativePlugin;
  let unavailable = true;
  const fetcher = vi.fn(async () => unavailable ? new Response(null, { status: 404 }) : new Response(new Uint8Array([1, 2, 3])));
  const android = await createAndroidAdapter({ plugin,
    app: { getState: async () => ({ isActive: true }), minimizeApp: async () => {}, addListener: listener },
    convertFileSrc: path => "https://localhost/_capacitor_file_" + path.slice(7), fetcher,
  });
  state.active = {
    config: { appOrigin: "https://example.test", firebase: { projectId } },
    firebaseApp: {}, uid, device: state.device, platform: android, viewer: { uid, name: "Fixture owner" },
    accessToken: async () => "synthetic", signOut: async () => {}, disposeData: async () => {},
  } as unknown as ActiveSession;

  try {
    render(<App />);
    await screen.findByText("Shared file is unavailable");
    expect(screen.queryByRole("heading", { name: "Contexts is unavailable" })).toBeNull();
    expect(screen.getAllByRole("textbox").some(node => node.tagName === "TEXTAREA")).toBe(true);
    await waitFor(() => expect(acknowledged).toEqual([first, last]));
    await waitFor(() => expect(state.publish).toHaveBeenCalledTimes(2));

    const readsBeforeRetry = fetcher.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(readsBeforeRetry));
    await screen.findByText("Shared file is unavailable");
    expect(acknowledged).toEqual([first, last]);
    expect((await drafts.list())[draftId]?.text).toBe(draftText);

    unavailable = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(acknowledged).toEqual([first, last, unreadable]));
    await waitFor(() => expect(state.publish).toHaveBeenCalledTimes(4));
    expect(storedWhenAcknowledged).toEqual([true, true, true]);
    expect((await drafts.list())[draftId]?.text).toBe(draftText);
  } finally {
    cleanup();
    android.dispose();
    outbox.close();
  }
});
