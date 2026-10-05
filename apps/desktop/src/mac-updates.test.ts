import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MacUpdateBackend } from "./mac-updates.js";
import { darwinUpdateFixture } from "./update-test-fixtures.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

it("downloads the selected DMG and opens only its freshly re-verified cache path", async () => {
  const bytes = Buffer.from("verified desktop installer");
  const artifact = darwinUpdateFixture("0.5.5", bytes);
  const directory = await mkdtemp(join(tmpdir(), "mdc-mac-update-")); directories.push(directory);
  const openPath = vi.fn(async () => "");
  const backend = new MacUpdateBackend(directory, { openPath }, async () => new Response(bytes, { status: 200 }));
  await backend.prepare(artifact, "0.5.5");
  const verified = await backend.download(artifact, vi.fn());
  await backend.install(verified);
  expect(openPath).toHaveBeenCalledWith(verified.path);
});

it("does not open a DMG replaced after download", async () => {
  const bytes = Buffer.from("verified desktop installer");
  const artifact = darwinUpdateFixture("0.5.5", bytes);
  const directory = await mkdtemp(join(tmpdir(), "mdc-mac-update-")); directories.push(directory);
  const openPath = vi.fn(async () => "");
  const backend = new MacUpdateBackend(directory, { openPath }, async () => new Response(bytes, { status: 200 }));
  const verified = await backend.download(artifact, vi.fn());
  await writeFile(verified.path, "tampered");
  await expect(backend.install(verified)).rejects.toThrow(/changed|size|checksum/i);
  expect(openPath).not.toHaveBeenCalled();
});
