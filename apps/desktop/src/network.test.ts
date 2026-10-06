import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { desktopFetch } from "./network.js";

const electron = vi.hoisted(() => ({ fetch: vi.fn(), request: vi.fn() }));
vi.mock("electron", () => ({ net: electron }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("uses Chromium for HTTPS while retaining abort, redirect and explicit authentication", async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Node TLS is not the desktop transport"); }));
  const response = new Response("ok");
  electron.fetch.mockResolvedValue(response);
  const signal = new AbortController().signal;
  const headers = new Headers({ Authorization: "Bearer synthetic-test-token" });
  const result = await desktopFetch(new URL("https://app.example.test/api/session"), {
    method: "POST", body: "{}", headers, signal, redirect: "error",
  });
  expect(result).toBe(response);
  expect(electron.fetch).toHaveBeenCalledExactlyOnceWith("https://app.example.test/api/session", {
    method: "POST", body: "{}", headers, signal, redirect: "error",
    credentials: "omit", cache: "no-store", bypassCustomProtocolHandlers: true,
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("never inherits renderer cookies or cached responses and preserves manual redirect checks", async () => {
  const probe = new EventEmitter() as EventEmitter & { setHeader: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
  probe.setHeader = vi.fn(); probe.abort = vi.fn();
  probe.end = vi.fn(() => probe.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/file"));
  electron.request.mockReturnValue(probe);
  const result = await desktopFetch("https://github.com/example/release", {
    redirect: "manual", credentials: "include", cache: "force-cache",
  });
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe("https://release-assets.githubusercontent.com/file");
  expect(electron.request).toHaveBeenCalledWith({
    url: "https://github.com/example/release", method: "GET", redirect: "manual", credentials: "omit", useSessionCookies: false,
    cache: "no-store", bypassCustomProtocolHandlers: true,
  });
  expect(probe.abort).toHaveBeenCalledOnce();
  expect(electron.fetch).not.toHaveBeenCalled();
});

it("streams an approved non-redirect response through Chromium and rejects a later redirect", async () => {
  const probe = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(), abort: vi.fn(), end: vi.fn(),
  });
  probe.end.mockImplementation(() => probe.emit("response", { statusCode: 200 }));
  electron.request.mockReturnValue(probe);
  const response = new Response("synthetic bytes"); electron.fetch.mockResolvedValue(response);
  expect(await desktopFetch("https://release-assets.githubusercontent.com/file", { redirect: "manual" })).toBe(response);
  expect(probe.abort).toHaveBeenCalledOnce();
  expect(electron.fetch).toHaveBeenCalledWith("https://release-assets.githubusercontent.com/file", {
    redirect: "error", credentials: "omit", cache: "no-store", bypassCustomProtocolHandlers: true,
  });
  electron.fetch.mockRejectedValue(new Error("Redirect was cancelled"));
  await expect(desktopFetch("https://release-assets.githubusercontent.com/file", { redirect: "manual" })).rejects.toThrow("Redirect was cancelled");
});

it("aborts pending manual probes and preserves the signal reason", async () => {
  const controller = new AbortController();
  const probe = Object.assign(new EventEmitter(), { setHeader: vi.fn(), abort: vi.fn(), end: vi.fn() });
  electron.request.mockReturnValue(probe);
  const task = desktopFetch("https://github.com/example/release", { redirect: "manual", signal: controller.signal });
  const failure = new Error("Synthetic cancellation");
  const rejection = expect(task).rejects.toBe(failure);
  controller.abort(failure); await rejection;
  expect(probe.abort).toHaveBeenCalledOnce();
  expect(electron.fetch).not.toHaveBeenCalled();
});

it("propagates certificate failures without falling back or overriding verification", async () => {
  const failure = new Error("net::ERR_CERT_AUTHORITY_INVALID");
  electron.fetch.mockRejectedValue(failure);
  await expect(desktopFetch("https://untrusted.example.test")).rejects.toBe(failure);
  expect(electron.fetch).toHaveBeenCalledOnce();
});

it("honors manual redirect policy carried by a Request input", async () => {
  const probe = Object.assign(new EventEmitter(), { setHeader: vi.fn(), abort: vi.fn(), end: vi.fn() });
  probe.end.mockImplementation(() => probe.emit("redirect", 302, "GET", "https://example.test/next"));
  electron.request.mockReturnValue(probe);
  const result = await desktopFetch(new Request("https://example.test", { redirect: "manual" }));
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe("https://example.test/next");
  expect(electron.fetch).not.toHaveBeenCalled();
});
