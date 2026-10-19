// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ContextOrigin, Id } from "@mdc/contracts";
import { CONTEXT_ORIGIN_PALETTE, contextSourceLabel, useContextOrigins } from "./context-origins.js";
import type { ContextRecord } from "./model.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin: ContextOrigin = { id: id(900), name: "Original laptop", colorIndex: 0 };
const chat = (n: number): ContextRecord => ({ id: id(n), title: `Chat ${n}`, createdAt: n, updatedAt: n, syncState: "synced", originDeviceId: origin.id });
afterEach(cleanup);
function fixture(contexts = [chat(1)]) {
  const load = vi.fn(async (_contextIds: Id[]) => [{ ...origin }]);
  const props = { owner: {}, contexts, enabled: true, active: true, deviceName: "Laptop", accessMode: "all", load };
  const view = renderHook(p => useContextOrigins(p), { initialProps: props });
  return { ...view, props, load };
}
it("batches saved chats in groups of 100 and does not refetch for titles, pins or ordering", async () => {
  const t = fixture(Array.from({ length: 205 }, (_, i) => chat(i + 1)));
  await waitFor(() => expect(t.result.current.origins.get(origin.id)).toEqual(origin));
  expect(t.load.mock.calls.map(args => args[0].length)).toEqual([100, 100, 5]);
  t.rerender({ ...t.props, contexts: [...t.props.contexts].reverse().map(c => ({ ...c, title: "Renamed", pinnedAt: 99 })) });
  expect(t.load).toHaveBeenCalledTimes(3);
  expect(contextSourceLabel(chat(1), t.result.current.origins)).toBe("Created on: Original laptop");
});
it("refreshes new contexts, device rename, explicit refresh and foreground without retry loops", async () => {
  const t = fixture();
  await waitFor(() => expect(t.result.current.origins.size).toBe(1));
  t.rerender({ ...t.props, contexts: [chat(1), chat(2)] });
  await waitFor(() => expect(t.load).toHaveBeenCalledTimes(2));
  t.load.mockResolvedValue([{ ...origin, name: "Current laptop name" }]);
  t.rerender({ ...t.props, contexts: [chat(1), chat(2)], deviceName: "Current laptop name" });
  await waitFor(() => expect(t.result.current.origins.get(origin.id)?.name).toBe("Current laptop name"));
  await act(async () => t.result.current.refresh());
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(t.load).toHaveBeenCalledTimes(5);
  expect(t.result.current.origins.get(origin.id)?.colorIndex).toBe(0);
});
it("keeps successful metadata on nonfatal failure, removes missing origins on success and supports old clients", async () => {
  const t = fixture();
  await waitFor(() => expect(t.result.current.origins.size).toBe(1));
  t.load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => t.result.current.refresh());
  expect(t.result.current.origins.get(origin.id)).toEqual(origin);
  expect(t.load).toHaveBeenCalledTimes(2);
  t.load.mockResolvedValue([]);
  await act(async () => t.result.current.refresh());
  expect(t.result.current.origins.size).toBe(0);
  const old = renderHook(() => useContextOrigins({ owner: {}, contexts: [chat(1)], enabled: true, active: true, deviceName: "Old client" }));
  expect(old.result.current.origins.size).toBe(0);
});
it("isolates account and access changes and rejects late results from an old workspace", async () => {
  const t = fixture();
  await waitFor(() => expect(t.result.current.origins.size).toBe(1));
  let resolve!: (value: ContextOrigin[]) => void;
  t.load.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  act(() => t.result.current.refresh());
  t.rerender({ ...t.props, owner: {}, load: vi.fn(async () => []) });
  expect(t.result.current.origins.size).toBe(0);
  await act(async () => resolve([{ ...origin, name: "Private old account" }]));
  expect(t.result.current.origins.size).toBe(0);
  t.rerender({ ...t.props, accessMode: "own" });
  expect(t.result.current.origins.size).toBe(0);
  await waitFor(() => expect(t.result.current.origins.size).toBe(1));
  t.rerender({ ...t.props, enabled: false });
  expect(t.result.current.origins.size).toBe(0);
});
it("stays neutral for drafts and unknown origins, and invalidates metadata after access revocation", async () => {
  const accessActive = vi.fn(() => true);
  const t = fixture([{ ...chat(1), syncState: "pending" }]);
  expect(t.load).not.toHaveBeenCalled();
  expect(contextSourceLabel(chat(1), t.result.current.origins)).toBe("Created on: Unknown device");
  const p = { ...t.props, contexts: [chat(1)], accessActive };
  t.rerender(p);
  await waitFor(() => expect(t.result.current.origins.size).toBe(1));
  accessActive.mockReturnValue(false);
  t.rerender(p);
  expect(t.result.current.origins.size).toBe(0);
});
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  });
  return .2126 * r! + .7152 * g! + .0722 * b!;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0]! + .05) / (values[1]! + .05);
}
it("has eight distinct pale/muted pairs with readable neutral text at rest and on selection", () => {
  expect(CONTEXT_ORIGIN_PALETTE).toHaveLength(8);
  for (let column = 0; column < 4; column++) {
    expect(new Set(CONTEXT_ORIGIN_PALETTE.map(pair => pair[column])).size).toBe(8);
    for (const pair of CONTEXT_ORIGIN_PALETTE) expect(contrast(pair[column]!, column < 2 ? "#202822" : "#edf2e9")).toBeGreaterThanOrEqual(4.5);
  }
  expect(CONTEXT_ORIGIN_PALETTE.slice(0, 3).map(pair => [pair[0], pair[2]])).toEqual([
    ["#e8f0f8", "#293847"], ["#efebf7", "#383247"], ["#f7eee4", "#43382d"],
  ]);
});
