// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccessPanel } from "./AccessPage.js";
import type { AccessClient } from "./access-client.js";
import type { AccessDevice } from "@mdc/contracts";
const id = "00000000-0000-4000-8000-000000000001";
const device = { id, name: "Phone", platform: "android" as const, mode: "own" as const, version: 1, createdAt: 1, updatedAt: 1 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function client(registered = true) {
  return { status: vi.fn(async () => ({ passkeyRegistered: registered })), devices: vi.fn(async (): Promise<AccessDevice[]> => [device]), register: vi.fn(async () => {}), perform: vi.fn(async () => ({ kind: "device", device: { ...device, mode: "all", version: 2 } })), listKeys: vi.fn(async () => []), createKey: vi.fn(), revokeKey: vi.fn() };
}
it("offers first registration before it exposes permission-changing controls", async () => {
  const api = client(false); render(<AccessPanel client={api as unknown as AccessClient} account="owner@example.test" />);
  expect(await screen.findByRole("button", { name: "Create passkey" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow all contexts on Phone" })).toBeNull();
  api.status.mockResolvedValue({ passkeyRegistered: true });
  await userEvent.click(screen.getByRole("button", { name: "Create passkey" }));
  expect(await screen.findByRole("button", { name: "Allow all contexts on Phone" })).toBeTruthy();
  expect(api.register).toHaveBeenCalledTimes(1);
});
it("confirms the exact displayed device and policy version then refreshes its state", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const api = client(); render(<AccessPanel client={api as unknown as AccessClient} account="owner@example.test" />);
  await userEvent.click(await screen.findByRole("button", { name: "Allow all contexts on Phone" }));
  await waitFor(() => expect(api.perform).toHaveBeenCalledWith({ action: "set-device-access", targetId: id, expectedVersion: 1, mode: "all" }));
  expect((await screen.findByRole("status")).textContent).toContain("Access updated for Phone");
  await waitFor(() => expect(api.devices).toHaveBeenCalledTimes(2));
  expect(confirm).not.toHaveBeenCalled();
});
it("warns about the target device's unsent foreign-context data before downgrade and cancels without requesting a challenge", async () => {
  const api = client(); api.devices.mockResolvedValue([{ ...device, mode: "all", version: 7 }]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<AccessPanel client={api as unknown as AccessClient} account="owner@example.test" />);
  await userEvent.click(await screen.findByRole("button", { name: "Limit to own contexts on Phone" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  const warning = confirm.mock.calls[0]?.[0];
  expect(warning).toContain("Phone");
  expect(warning).toContain("unsent drafts");
  expect(warning).toContain("queued messages and files");
  expect(warning).toContain("unfinished operations");
  expect(warning).toContain("contexts created on other devices");
  expect(api.perform).not.toHaveBeenCalled();
  expect(screen.getByText("All contexts")).toBeTruthy();
});
it("starts the exact downgrade passkey ceremony only after accepting the data-loss warning", async () => {
  const api = client(); api.devices.mockResolvedValue([{ ...device, mode: "all", version: 7 }]);
  const confirm = vi.spyOn(window, "confirm").mockImplementation(() => {
    expect(api.perform).not.toHaveBeenCalled();
    return true;
  });
  render(<AccessPanel client={api as unknown as AccessClient} account="owner@example.test" />);
  await userEvent.click(await screen.findByRole("button", { name: "Limit to own contexts on Phone" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.perform).toHaveBeenCalledWith({ action: "set-device-access", targetId: id, expectedVersion: 7, mode: "own" }));
});
it("leaves the displayed grant unchanged when passkey approval is cancelled", async () => {
  const api = client(); api.perform.mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
  render(<AccessPanel client={api as unknown as AccessClient} account="owner@example.test" />);
  await userEvent.click(await screen.findByRole("button", { name: "Allow all contexts on Phone" }));
  expect((await screen.findByRole("alert")).textContent).toContain("cancelled");
  expect(screen.getByRole("button", { name: "Allow all contexts on Phone" })).toBeTruthy();
});
