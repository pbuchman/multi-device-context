// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccountDetails } from "./account-details.js";
import { AccountProfileStore, ProfileLoadError } from "./account-profile.js";
afterEach(cleanup);
it("shows the failure and retries without a logout or a page reload", async () => {
  const load=vi.fn().mockRejectedValueOnce(new ProfileLoadError("Provider lookup failed",false)).mockResolvedValue({name:"Alice",email:"alice@example.test"});
  const profile=new AccountProfileStore("owner",load,()=>true);
  await profile.refresh();
  const view=render(<AccountDetails viewer={profile.getSnapshot()} profile={profile}/>);
  expect(screen.getByText("Provider lookup failed")).toBeTruthy();
  await userEvent.click(screen.getByRole("button",{name:"Retry account details"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Refresh account details"})).toBeTruthy());
  view.rerender(<AccountDetails viewer={profile.getSnapshot()} profile={profile}/>);
  expect(screen.getByText("alice@example.test")).toBeTruthy();expect(screen.queryByText("Provider lookup failed")).toBeNull();profile.dispose();
});
it("shows loading and prevents duplicate account requests", async()=>{
  let finish!: (value:{name:string})=>void;
  const profile=new AccountProfileStore("owner",()=>new Promise(resolve=>{finish=resolve;}),()=>true);
  const view=render(<AccountDetails viewer={profile.getSnapshot()} profile={profile}/>);
  let pending!:Promise<void>;act(()=>{pending=profile.refresh();});
  expect((screen.getByRole("button",{name:"Loading account details…"}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Loading account…")).toBeTruthy();
  await act(async()=>{finish({name:"Alice"});await pending;});view.unmount();profile.dispose();
});
