import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnectionFailure,
  RecoveryDiagnostics,
} from "./recovery-diagnostics.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mdc-recovery-diagnostic-"));
  directories.push(directory);
  const path = join(directory, "connection-diagnostic.json");
  return { path, diagnostics: new RecoveryDiagnostics(path, "0.5.5") };
}

describe("recovery connection diagnostics", () => {
  it("finds a nested Node TLS cause and persists only fixed safe fields", async () => {
    const { path, diagnostics } = await fixture();
    const secret = "https://workspace.example.test/?token=very-secret";
    const cause = Object.assign(new Error(secret), {
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    });
    const diagnostic = await diagnostics.record(
      "workspace",
      new Error(`request failed for ${secret}`, { cause }),
    );

    expect(diagnostic).toMatchObject({
      stage: "workspace",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "The secure connection certificate could not be verified.",
      appVersion: "0.5.5",
    });
    expect(diagnostic.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const persisted = await readFile(path, "utf8");
    expect(JSON.parse(persisted)).toEqual(diagnostic);
    expect(persisted).not.toContain("workspace.example.test");
    expect(persisted).not.toContain("very-secret");
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("recognizes exact Chromium network errors without copying raw text", async () => {
    const { diagnostics } = await fixture();
    const diagnostic = await diagnostics.record(
      "renderer",
      { errorDescription: "net::ERR_CERT_AUTHORITY_INVALID" },
    );
    expect(diagnostic).toMatchObject({
      code: "ERR_CERT_AUTHORITY_INVALID",
      message: "The secure connection certificate could not be verified.",
    });
  });

  it("records bounded application failures and an integer HTTP status", async () => {
    const { diagnostics } = await fixture();
    await expect(
      diagnostics.record("configuration", new ConnectionFailure("ORIGIN_MISMATCH")),
    ).resolves.toMatchObject({
      code: "ORIGIN_MISMATCH",
      message: "The shared workspace responded from an unexpected origin.",
    });
    await expect(
      diagnostics.record("workspace", new ConnectionFailure("HTTP_ERROR", 503)),
    ).resolves.toMatchObject({
      code: "HTTP_ERROR",
      httpStatus: 503,
      message: "The shared workspace returned an HTTP error.",
    });
  });

  it("redacts unknown errors, unsafe version text, and cyclic causes", async () => {
    const { path } = await fixture();
    const diagnostics = new RecoveryDiagnostics(path, "0.5.5 /Users/private");
    const error = new Error("Bearer abc123 at C:\\Users\\Private\\settings.json");
    (error as Error & { cause?: unknown }).cause = error;
    const diagnostic = await diagnostics.record("workspace", error);

    expect(diagnostic).toMatchObject({
      code: "CONNECTION_FAILED",
      message: "Multi Device Context could not connect to the shared workspace.",
      appVersion: "unknown",
    });
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("abc123");
    expect(persisted).not.toContain("Users");
  });

  it("keeps recovery usable when the diagnostic file cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mdc-recovery-write-failure-"));
    directories.push(directory);
    const blockingFile = join(directory, "not-a-directory");
    await writeFile(blockingFile, "occupied");
    const diagnostics = new RecoveryDiagnostics(
      join(blockingFile, "diagnostic.json"),
      "0.5.5",
    );

    await expect(
      diagnostics.record("workspace", Object.assign(new Error(), { code: "ENOTFOUND" })),
    ).resolves.toMatchObject({ code: "ENOTFOUND" });
    expect(diagnostics.current()).toMatchObject({ code: "ENOTFOUND" });
    diagnostics.clear();
    expect(diagnostics.current()).toBeUndefined();
    expect(await readFile(blockingFile, "utf8")).toBe("occupied");
  });

  it("stores only the latest diagnostic", async () => {
    const { path, diagnostics } = await fixture();
    await diagnostics.record("workspace", Object.assign(new Error(), { code: "ETIMEDOUT" }));
    const latest = await diagnostics.record(
      "renderer",
      Object.assign(new Error(), { code: "ECONNREFUSED" }),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(latest);
  });
});
