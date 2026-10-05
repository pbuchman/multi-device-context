// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { AccountProfileStore, ProfileLoadError } from "./account-profile.js";
afterEach(() => vi.useRealTimers());
it("recovers a temporary failure automatically and keeps profile in this session only", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new ProfileLoadError("Temporary failure", true)).mockResolvedValue({ name: "Alice", email: "alice@example.test" });
  const profile = new AccountProfileStore("owner", load, () => true);
  await profile.refresh(); expect(profile.getState().status).toBe("unavailable");
  await vi.advanceTimersByTimeAsync(2000);
  expect(profile.getSnapshot()).toEqual({ uid: "owner", name: "Alice", email: "alice@example.test" });
  expect(load).toHaveBeenCalledTimes(2);profile.dispose();
});
it("coalesces retries and ignores an old account's late response", async () => {
  let finish!: (data: { name: string }) => void;let current = true;
  const load = vi.fn(() => new Promise<{ name: string }>(resolve => { finish = resolve; }));
  const profile = new AccountProfileStore("owner", load, () => current);
  const first = profile.refresh(), second = profile.refresh();expect(load).toHaveBeenCalledOnce();
  current = false;profile.dispose();finish({name:"Old account"});await Promise.all([first,second]);
  expect(profile.getSnapshot()).toEqual({uid:"owner",name:"Signed in"});
});
it("keeps retry available after permanent provider failure without retry loops", async () => {
  vi.useFakeTimers();const load=vi.fn().mockRejectedValueOnce(new ProfileLoadError("Sign-in provider rejected account lookup.",false)).mockResolvedValue({email:"alice@example.test"});
  const profile=new AccountProfileStore("owner",load,()=>true);await profile.refresh();await vi.advanceTimersByTimeAsync(30_000);
  window.dispatchEvent(new Event("focus"));window.dispatchEvent(new Event("online"));
  expect(load).toHaveBeenCalledOnce();expect(profile.getState().message).toContain("rejected");
  await profile.refresh();expect(profile.getSnapshot().name).toBe("alice@example.test");profile.dispose();
});
it("respects provider retry-after and cancels scheduled work on disposal", async()=>{
  vi.useFakeTimers();const load=vi.fn().mockRejectedValue(new ProfileLoadError("Please wait",true,10_000));
  const profile=new AccountProfileStore("owner",load,()=>true);await profile.refresh();await profile.refresh();
  await vi.advanceTimersByTimeAsync(9999);expect(load).toHaveBeenCalledOnce();profile.dispose();
  await vi.advanceTimersByTimeAsync(30_000);expect(load).toHaveBeenCalledOnce();
});
it("publishes verified account text before the optional avatar finishes", async () => {
  let finishAvatar!: (value: string) => void;
  const loadAvatar = vi.fn(() => new Promise<string>(resolve => { finishAvatar = resolve; }));
  const profile = new AccountProfileStore(
    "owner",
    async () => ({ name: "Alice", email: "alice@example.test" }),
    () => true,
    loadAvatar,
  );
  await profile.refresh();
  expect(profile.getSnapshot()).toEqual({ uid: "owner", name: "Alice", email: "alice@example.test" });
  expect(profile.getState().status).toBe("ready");
  expect(loadAvatar).toHaveBeenCalledOnce();
  finishAvatar("data:image/png;base64,AAH/");
  await vi.waitFor(() => expect(profile.getSnapshot().avatarUrl).toBe("data:image/png;base64,AAH/"));
  profile.dispose();
});
