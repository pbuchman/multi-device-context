// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentKeys } from "./AgentKeys.js";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shows a created key once and lets the owner revoke it", async () => {
  const client = {
    listKeys: vi.fn(async () => []),
    createKey: vi.fn(async (name: string) => ({ id: "test-id", name, key: "mdc_synthetic_test_key", createdAt: 1, lastUsedAt: null })),
    revokeKey: vi.fn(async () => {}),
  };
  render(<AgentKeys client={client} />);
  await userEvent.type(screen.getByLabelText("Agent key name"), "Mac agent");
  await userEvent.click(screen.getByRole("button", { name: "Create key" }));
  expect((await screen.findByLabelText("New agent key") as HTMLInputElement).value).toBe("mdc_synthetic_test_key");
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByLabelText("New agent key")).toBeNull();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(client.revokeKey).toHaveBeenCalledWith("test-id"));
  expect(screen.queryByText("Mac agent")).toBeNull();
});
