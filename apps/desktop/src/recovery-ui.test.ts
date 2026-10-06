// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

declare global {
  interface Window {
    contextRecovery: {
      retry(): Promise<void>;
      getConnectionDiagnostic?(): Promise<unknown>;
    };
  }
}

function renderRecovery() {
  document.body.innerHTML = `
    <div id="diagnostic" hidden>
      <p id="diagnostic-message"></p>
      <code id="diagnostic-code"></code>
    </div>
    <button id="retry" type="button">Try again</button>
    <p id="status"></p>
  `;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.innerHTML = "";
});

it("renders the bounded diagnostic with textContent and retains retry", async () => {
  renderRecovery();
  const diagnostic = {
    stage: "workspace",
    code: "ERR_CERT_AUTHORITY_INVALID",
    message: "Certificate <strong>details</strong> are unavailable.",
    occurredAt: "2026-10-06T10:00:00.000Z",
    appVersion: "0.5.5",
  };
  const retry = vi.fn().mockResolvedValue(undefined);
  window.contextRecovery = {
    retry,
    getConnectionDiagnostic: vi.fn().mockResolvedValue(diagnostic),
  };

  // @ts-expect-error The recovery asset is intentionally a browser-only script.
  await import("../resources/recovery.js");
  await vi.waitFor(() => expect(document.getElementById("diagnostic")!.hidden).toBe(false));
  expect(document.getElementById("diagnostic-message")!.textContent).toBe(
    diagnostic.message,
  );
  expect(document.querySelector("#diagnostic-message strong")).toBeNull();
  expect(document.getElementById("diagnostic-code")!.textContent).toBe(
    "ERR_CERT_AUTHORITY_INVALID",
  );

  document.getElementById("retry")!.click();
  await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(document.getElementById("status")!.textContent).toBe("Connecting…");
});

it("keeps generic recovery usable when no diagnostic is available", async () => {
  renderRecovery();
  window.contextRecovery = {
    retry: vi.fn().mockRejectedValue(new Error("still offline")),
    getConnectionDiagnostic: vi.fn().mockRejectedValue(new Error("unavailable")),
  };

  // @ts-expect-error The recovery asset is intentionally a browser-only script.
  await import("../resources/recovery.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.getElementById("diagnostic")!.hidden).toBe(true);

  document.getElementById("retry")!.click();
  await vi.waitFor(() =>
    expect(document.getElementById("status")!.textContent).toBe(
      "Still unavailable. Please try again shortly.",
    ),
  );
  expect((document.getElementById("retry") as HTMLButtonElement).disabled).toBe(false);
});
