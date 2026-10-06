// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeUpdates, UpdateState } from "@mdc/contracts";

import {
  HostedUpdateMonitor,
  createNativeUpdateClient,
  parseBuildMetadata,
  prepareAndInstallNativeUpdate,
} from "./updates.js";

afterEach(() => vi.useRealTimers());

describe("hosted UI metadata", () => {
  it("accepts a public source build identifier and rejects private or malformed fields", () => {
    expect(parseBuildMetadata({ uiBuild: "a".repeat(40) })).toEqual({ uiBuild: "a".repeat(40) });
    expect(() => parseBuildMetadata({ uiBuild: "a".repeat(40), secret: "no" })).toThrow();
    expect(() => parseBuildMetadata({ uiBuild: "main" })).toThrow();
  });

  it("checks at startup and every six hours, reporting only a different build", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uiBuild: "a".repeat(40) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ uiBuild: "b".repeat(40) })));
    const changes: Array<string | undefined> = [];
    const monitor = new HostedUpdateMonitor("a".repeat(40), fetcher, value => changes.push(value));

    monitor.start();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/version", { cache: "no-store", signal: expect.any(AbortSignal) });
    expect(changes).toEqual([undefined, "b".repeat(40)]);
    monitor.dispose();
  });

  it("does not publish a late result after disposal", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const changed = vi.fn();
    const monitor = new HostedUpdateMonitor("a".repeat(40), fetcher, changed);
    monitor.start();
    monitor.dispose();
    resolve(new Response(JSON.stringify({ uiBuild: "b".repeat(40) })));
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
  });

  it("coalesces overlapping checks into one bounded network request", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>(done => { resolve = done; });
    });
    const monitor = new HostedUpdateMonitor("a".repeat(40), fetcher, vi.fn());
    monitor.start();

    const manual = monitor.check(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({ uiBuild: "b".repeat(40) })));
    await manual;

    expect(fetcher).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });
});

describe("optional native updates", () => {
  const state = (status: UpdateState["status"]): UpdateState => ({
    status,
    platform: "darwin",
    currentVersion: "1.0.0",
  });

  it("leaves old and partially upgraded bridges usable without exposing updates", () => {
    expect(createNativeUpdateClient({})).toBeUndefined();
    expect(createNativeUpdateClient({ getUpdateState: async () => state("idle") })).toBeUndefined();
  });

  it("forwards progress, failures, and unsubscribe without late state", async () => {
    let listener: ((value: UpdateState) => void) | undefined;
    const unsubscribe = vi.fn();
    const native: NativeUpdates = {
      getUpdateState: vi.fn(async () => state("idle")),
      checkForUpdates: vi.fn(async () => state("up-to-date")),
      startUpdate: vi.fn(async () => state("ready")),
      installUpdate: vi.fn(async () => undefined),
      onUpdateState: vi.fn(next => { listener = next; return unsubscribe; }),
    };
    const client = createNativeUpdateClient(native)!;
    const received: UpdateState[] = [];
    const dispose = client.subscribe(value => received.push(value));
    listener?.({ status: "downloading", platform: "darwin", currentVersion: "1.0.0", availableVersion: "1.1.0", progress: { transferred: 5, total: 10, percent: 50 } });
    listener?.({ status: "error", platform: "darwin", currentVersion: "1.0.0", message: "Download failed" });
    dispose();
    listener?.(state("ready"));

    expect(received.map(value => value.status)).toEqual(["downloading", "error"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("flushes while frozen but unlocks before handing off to the native installer", async () => {
    const events: string[] = [];
    const native = {
      startUpdate: async () => { events.push("download"); return { ...state("ready"), availableVersion: "1.1.0" }; },
      installUpdate: async () => { events.push("install"); },
    };

    await prepareAndInstallNativeUpdate(native, "desktop", {
      freeze(value) { events.push(value ? "freeze" : "unfreeze"); },
      async settle() { events.push("settle"); },
      current: () => true,
      canInstall: () => true,
    });

    expect(events).toEqual(["download", "freeze", "settle", "unfreeze", "install"]);
  });

  it("stays unlocked when the desktop installer handoff rejects", async () => {
    const events: string[] = [];
    const native = {
      startUpdate: async () => ({ status: "ready", platform: "win32", currentVersion: "1.0.0", availableVersion: "1.1.0", progress: { transferred: 10, total: 10, percent: 100 } }) satisfies UpdateState,
      installUpdate: async () => { events.push("install"); throw new Error("Installer launch failed"); },
    };

    await expect(prepareAndInstallNativeUpdate(native, "desktop", {
      freeze(value) { events.push(value ? "freeze" : "unfreeze"); },
      async settle() { events.push("settle"); }, current: () => true, canInstall: () => true,
    })).rejects.toThrow("Installer launch failed");

    expect(events).toEqual(["freeze", "settle", "unfreeze", "install"]);
  });

  it("keeps Android input frozen through system-installer handoff and always unlocks", async () => {
    const events: string[] = [];
    const native = {
      startUpdate: async () => ({ ...state("ready"), platform: "android" as const, availableVersion: "1.1.0" }),
      installUpdate: async () => { events.push("install"); throw new Error("Installation declined"); },
    };

    await expect(prepareAndInstallNativeUpdate(native, "android", {
      freeze(value) { events.push(value ? "freeze" : "unfreeze"); },
      async settle() { events.push("settle"); },
      current: () => true,
      canInstall: () => true,
    })).rejects.toThrow("Installation declined");

    expect(events).toEqual(["freeze", "settle", "install", "unfreeze"]);
  });

  it.each(["sign-out", "deletion"])("does not install after %s starts during download", async () => {
    let finish!: (state: UpdateState) => void;
    let safe = true;
    const installUpdate = vi.fn(async () => undefined);
    const pending = prepareAndInstallNativeUpdate({
      startUpdate: () => new Promise<UpdateState>(resolve => { finish = resolve; }),
      installUpdate,
    }, "desktop", {
      freeze: vi.fn(), settle: vi.fn(async () => undefined), current: () => true, canInstall: () => safe,
    });

    safe = false;
    finish({ status: "ready", platform: "darwin", currentVersion: "1.0.0", availableVersion: "1.1.0", progress: { transferred: 10, total: 10, percent: 100 } });

    await expect(pending).rejects.toThrow(/Finish the current operation/);
    expect(installUpdate).not.toHaveBeenCalled();
  });
});
