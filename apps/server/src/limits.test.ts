import { expect, it, vi } from "vitest";
import { Readiness, WindowLimit } from "./limits.js";
it("R2: bounded cardinality fails closed and expired windows recover", () => {
  let now = 0; const limit = new WindowLimit(2, 1000, 2, () => now);
  expect(limit.take("a")).toBe(0); expect(limit.take("a")).toBe(0); expect(limit.take("a")).toBe(1);
  expect(limit.take("b")).toBe(0); expect(limit.take("c")).toBe(1);
  now = 1001; expect(limit.take("c")).toBe(0);
});
it("R2: stale success is not readiness and hung checks never overlap", async () => {
  let now = 1; let finish: (() => void) | undefined;
  const check = vi.fn(async () => {}); const readiness = new Readiness(check, () => now);
  await readiness.refresh(); expect(readiness.ok()).toBe(true);
  now += 45_001; expect(readiness.ok()).toBe(false);
  check.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = readiness.refresh(); await readiness.refresh(); expect(check).toHaveBeenCalledTimes(2);
  finish?.(); await pending; expect(readiness.ok()).toBe(true); readiness.close();
});

it("uses monotonic freshness even when the wall clock moves backwards", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01"));
    const readiness = new Readiness(async () => {});
    await readiness.refresh();
    vi.setSystemTime(new Date("2025-01-01"));
    expect(readiness.ok()).toBe(true);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(readiness.ok()).toBe(false);
    readiness.close();
  } finally { vi.useRealTimers(); }
});
it("immediately rejects a cached success when fatal and never revives after close", async () => {
  let fatal = false;
  let finish!: () => void;
  const check = vi.fn(async () => {});
  const readiness = new Readiness(check, () => 1, () => fatal);
  await readiness.refresh();
  expect(readiness.ok()).toBe(true);
  fatal = true;
  expect(readiness.ok()).toBe(false);
  fatal = false;
  check.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = readiness.refresh();
  readiness.close();
  finish();
  await pending;
  expect(readiness.ok()).toBe(false);
});
