import { describe, expect, it, vi } from "vitest";

import { DeletionCleanup, ForegroundCatchup, ForegroundRefresh } from "./sync.js";

describe("ForegroundRefresh", () => {
  it("coalesces concurrent refreshes and ignores a result after the identity changes", async () => {
    let finish!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const refresh = new ForegroundRefresh(15_000);
    const applied: string[] = [];

    const first = refresh.run("user:a", read, (value) => applied.push(value));
    const second = refresh.run("user:a", read, (value) => applied.push(value));
    expect(read).toHaveBeenCalledTimes(1);
    refresh.invalidate();
    finish("late");
    await Promise.all([first, second]);
    expect(applied).toEqual([]);
  });

  it("lets a newer scope start while an older scope is still pending", async () => {
    const pending = new Map<string, (value: string) => void>();
    const refresh = new ForegroundRefresh(15_000);
    const applied: string[] = [];
    const read = (scope: string) => new Promise<string>((resolve) => pending.set(scope, resolve));

    const oldRun = refresh.run("context:a", () => read("a"), value => applied.push(value));
    const newRun = refresh.run("context:b", () => read("b"), value => applied.push(value));
    pending.get("b")!("new");
    await newRun;
    pending.get("a")!("old");
    await oldRun;
    expect(applied).toEqual(["new"]);
  });

  it("rejects at the deadline and ignores the eventual result", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: string) => void;
      const refresh = new ForegroundRefresh(15_000);
      const applied: string[] = [];
      const run = refresh.run("contexts", () => new Promise<string>((resolve) => { finish = resolve; }), value => applied.push(value));
      const rejection = expect(run).rejects.toThrow("Refresh timed out");
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      finish("late");
      await Promise.resolve();
      expect(applied).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe("foreground completion ownership", () => {
  it("coalesces the whole operation and cancels late cleanup completion at its deadline", async () => {
    vi.useFakeTimers();
    try {
      const cycle = new ForegroundCatchup(15_000);
      let finish!: () => void;
      const recovered = vi.fn();
      const settled = vi.fn();
      const work = vi.fn(async (current: () => boolean) => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (current()) recovered();
      });
      const first = cycle.run("user:context", work, settled);
      const second = cycle.run("user:context", work, settled);
      expect(first).toBe(second);
      await vi.advanceTimersByTimeAsync(15_000);
      await first;
      expect(work).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: "Refresh timed out" }));
      finish();
      await Promise.resolve();
      expect(recovered).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does not finalize an invalidated identity", async () => {
    const cycle = new ForegroundCatchup();
    let finish!: () => void;
    const recovered = vi.fn();
    const settled = vi.fn();
    const first = cycle.run("old-account", async current => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (current()) recovered();
    }, settled);
    await Promise.resolve();
    cycle.invalidate();
    finish();
    await first;
    expect(recovered).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("remembers cleanup failures until the same tombstone is retried successfully", async () => {
    const barrier = new DeletionCleanup();
    const remove = vi.fn().mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce(undefined);
    await expect(barrier.reconcile(["deleted"], remove)).rejects.toThrow("storage unavailable");
    const resume = vi.fn();
    await expect(barrier.finish(() => true, resume)).rejects.toThrow("Could not remove local pending shares");
    expect(resume).not.toHaveBeenCalled();
    await barrier.reconcile(["deleted"], remove);
    await barrier.finish(() => true, resume);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
