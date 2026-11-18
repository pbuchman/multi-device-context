import { afterEach, expect, it, vi } from "vitest";
vi.mock("firebase/firestore", async original => ({ ...await original<typeof import("firebase/firestore")>(), initializeFirestore: () => ({}), memoryLocalCache: () => ({}) }));
import { FirebaseCloud } from "./cloud.js";
const id = "00000000-0000-4000-8000-000000000001";
function cloud() { return new FirebaseCloud({} as never, "owner", async () => "synthetic-auth", { id, name: "Test", platform: "browser", mode: "own", version: 1, createdAt: 1, updatedAt: 1 }); }
afterEach(() => vi.unstubAllGlobals());
it.each([[401,"auth",false],[403,"access",false],[404,"access",false],[429,"server",true],[503,"server",true]] as const)("retains a sanitized category and status for DELETE %s", async (status, category, retryable) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("synthetic private response body", { status })));
  await expect(cloud().deleteContext(id)).rejects.toMatchObject({ category, httpStatus: status, retryable });
});
it("reports network failure without retaining arbitrary response content", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("synthetic sensitive proxy message"); }));
  await expect(cloud().deleteContext(id)).rejects.toMatchObject({ category: "network", retryable: true });
});
it("requires the endpoint's explicit 204 confirmation and forwards conditional item deletion", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("wrong endpoint", { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher);
  await expect(cloud().deleteContext(id)).rejects.toMatchObject({ retryable: false });
  await expect(cloud().deleteItem(id, id, true)).resolves.toBeUndefined();
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ deleteEmptyContext: true }) });
});
it("classifies an expired session before HTTP as authentication failure",async()=>{
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
 const adapter=new FirebaseCloud({} as never,"owner",async()=>{throw new Error("Your session has expired");},{id,name:"Test",platform:"browser",mode:"own",version:1,createdAt:1,updatedAt:1});
 await expect(adapter.deleteContext(id)).rejects.toMatchObject({category:"auth",retryable:false});expect(fetcher).not.toHaveBeenCalled();
});
