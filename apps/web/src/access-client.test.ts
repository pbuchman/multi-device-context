import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessClient } from "./access-client.js";
const id = "00000000-0000-4000-8000-000000000001";
const device = { id, name: "Phone", platform: "android", mode: "all", version: 2, createdAt: 1, updatedAt: 2 };
afterEach(() => vi.unstubAllGlobals());
describe("passkey access client", () => {
  it("calls the default browser fetch without rebinding it to the AccessClient instance", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async function(this: unknown, input: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      calls.push(input);
      return new Response(JSON.stringify(input === "/api/access/status" ? { passkeyRegistered: true } : [device]));
    });
    const client = new AccessClient(async () => "google-owner");
    await expect(client.status()).resolves.toEqual({ passkeyRegistered: true });
    await expect(client.devices()).resolves.toEqual([device]);
    expect(calls).toEqual(["/api/access/status", "/api/access/devices"]);
  });
  it("completes only the action already bound to a server challenge", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ challengeId: id, options: { challenge: "challenge" } }))).mockResolvedValueOnce(new Response(JSON.stringify({ kind: "device", device })));
    const authenticate = vi.fn(async () => ({ id: "credential" }));
    const client = new AccessClient(async () => "google-owner", fetcher, { authenticate, register: vi.fn() } as any);
    await client.perform({ action: "set-device-access", targetId: id, expectedVersion: 1, mode: "all" });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ action: "set-device-access", targetId: id, expectedVersion: 1, mode: "all" });
    expect(fetcher.mock.calls[1]![0]).toBe(`/api/access/challenges/${id}/complete`);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ response: { id: "credential" } });
    expect(fetcher.mock.calls[1]![1].headers.authorization).toBe("Bearer google-owner");
  });
  it("does not complete a mutation if the user cancels the passkey prompt", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ challengeId: id, options: { challenge: "challenge" } })));
    const client = new AccessClient(async () => "google-owner", fetcher, { authenticate: vi.fn(async () => { throw new DOMException("Cancelled", "NotAllowedError"); }), register: vi.fn() } as any);
    await expect(client.perform({ action: "revoke-agent-key", targetId: id })).rejects.toThrow("Cancelled");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
