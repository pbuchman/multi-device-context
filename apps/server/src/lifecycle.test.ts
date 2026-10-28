import { afterEach, expect, it, vi } from "vitest";

import { RecoveryLifecycle } from "./lifecycle.js";
afterEach(() => vi.useRealTimers());
it("latches one fatal request, closes once, and exits on successful graceful disposal", async () => {
  vi.useFakeTimers();
  const exit = vi.fn(), close = vi.fn(async () => {}), forceClose = vi.fn();
  const lifecycle = new RecoveryLifecycle({ exit });
  lifecycle.attach({ close, forceClose });
  lifecycle.request("io-timeout");
  lifecycle.request("io-timeout");
  await vi.advanceTimersByTimeAsync(0);
  expect(close).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(forceClose).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledTimes(1);
});
it("forces sockets after ten seconds and exits by fifteen even when close hangs", async () => {
  vi.useFakeTimers();
  const exit = vi.fn(), close = vi.fn(() => new Promise(() => {})), forceClose = vi.fn();
  const lifecycle = new RecoveryLifecycle({ exit });
  lifecycle.attach({ close, forceClose });
  lifecycle.request("io-timeout");
  await vi.advanceTimersByTimeAsync(9_999);
  expect(forceClose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(forceClose).toHaveBeenCalledTimes(1);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(exit).toHaveBeenCalledExactlyOnceWith(75);
});
it("bounds fatal startup before a server reference exists and closes a late server once", async () => {
  vi.useFakeTimers();
  const exit = vi.fn(), close = vi.fn(() => new Promise(() => {})), forceClose = vi.fn();
  const lifecycle = new RecoveryLifecycle({ exit });
  lifecycle.request("io-timeout");
  await vi.advanceTimersByTimeAsync(11_000);
  lifecycle.attach({ close, forceClose });
  expect(close).toHaveBeenCalledTimes(1);
  expect(forceClose).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(exit).toHaveBeenCalledExactlyOnceWith(75);
});
it("never waits indefinitely for a server to appear during fatal startup", async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const lifecycle = new RecoveryLifecycle({ exit });
  lifecycle.request("io-timeout");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(exit).toHaveBeenCalledExactlyOnceWith(75);
});
it("operator shutdown exits successfully and ignores repeated requests", async () => {
  vi.useFakeTimers();
  const exit = vi.fn(), close = vi.fn(async () => {});
  const lifecycle = new RecoveryLifecycle({ exit });
  lifecycle.attach({ close, forceClose() {} });
  lifecycle.request("operator-signal");
  lifecycle.request("io-timeout");
  await vi.advanceTimersByTimeAsync(0);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(close).toHaveBeenCalledTimes(1);
});
it("still reaches the recovery exit when forced socket disposal throws", async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const lifecycle = new RecoveryLifecycle({ exit });
  lifecycle.attach({ close: () => new Promise(() => {}), forceClose() { throw new Error("socket close failed"); } });
  lifecycle.request("io-timeout");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(exit).toHaveBeenCalledExactlyOnceWith(75);
});
