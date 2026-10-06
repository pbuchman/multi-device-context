import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadVerifiedArtifact,
  fetchUpdateCatalog,
  reverifyDownloadedArtifact,
  verifyDownloadedArtifact,
} from "./update-files.js";
import { darwinUpdateFixture, updateCatalogFixture, windowsUpdateFixture } from "./update-test-fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const value = await mkdtemp(join(tmpdir(), "mdc-update-test-"));
  directories.push(value);
  return value;
}

describe("update catalog transport", () => {
  it("strictly parses the fixed bounded catalog without following redirects", async () => {
    const catalog = updateCatalogFixture();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "content-length": String(JSON.stringify(catalog).length) },
    }));
    await expect(fetchUpdateCatalog(fetcher)).resolves.toEqual(catalog);
    expect(fetcher).toHaveBeenCalledWith(
      "https://pbuchman.github.io/multi-device-context/updates/preview.json",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects oversized and partial catalog bodies", async () => {
    const oversized = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": "65537" },
    }));
    await expect(fetchUpdateCatalog(oversized)).rejects.toThrow(/too large/i);
    const partial = vi.fn(async () => new Response("{", { status: 200 }));
    await expect(fetchUpdateCatalog(partial)).rejects.toThrow(/valid JSON/i);
  });
});

describe("verified update files", () => {
  it("streams a matching artifact into the private cache and reports progress", async () => {
    const bytes = Buffer.from("verified desktop installer");
    const artifact = darwinUpdateFixture("0.5.5", bytes);
    const progress = vi.fn();
    const fetcher = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    }));
    const verified = await downloadVerifiedArtifact(artifact, await directory(), fetcher, progress);
    expect(await readFile(verified.path)).toEqual(bytes);
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
    await expect(reverifyDownloadedArtifact(verified)).resolves.toBe(verified.path);
  });

  it.each([
    ["partial response", Buffer.from("verified desktop")],
    ["bad hash", Buffer.from("tampered desktop installer")],
    ["excess bytes", Buffer.from("verified desktop installer plus bytes")],
  ])("removes a %s instead of caching it", async (_name, responseBytes) => {
    const expected = Buffer.from("verified desktop installer");
    const artifact = darwinUpdateFixture("0.5.5", expected);
    const target = await directory();
    await expect(downloadVerifiedArtifact(
      artifact,
      target,
      async () => new Response(responseBytes, { status: 200 }),
      () => {},
    )).rejects.toThrow(/size|checksum/i);
    await expect(readFile(join(target, artifact.name))).rejects.toThrow();
  });

  it("rejects redirects outside the exact GitHub release and approved CDN hosts", async () => {
    const bytes = Buffer.from("verified desktop installer");
    const artifact = darwinUpdateFixture("0.5.5", bytes);
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/installer.dmg" },
    }));
    await expect(downloadVerifiedArtifact(artifact, await directory(), fetcher, () => {})).rejects.toThrow(/redirect/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("follows a bounded approved GitHub CDN redirect without forwarding credentials", async () => {
    const bytes = Buffer.from("verified desktop installer");
    const artifact = darwinUpdateFixture("0.5.5", bytes);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://release-assets.githubusercontent.com/object?signature=one" },
      }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    await downloadVerifiedArtifact(artifact, await directory(), fetcher, () => {});
    expect(fetcher).toHaveBeenNthCalledWith(2,
      "https://release-assets.githubusercontent.com/object?signature=one",
      expect.not.objectContaining({ headers: expect.anything() }),
    );
  });

  it("aborts a stalled artifact download on the bounded deadline", async () => {
    const artifact = darwinUpdateFixture();
    const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const download = downloadVerifiedArtifact(artifact, await directory(), fetcher, () => {}, 20);
    await expect(download).rejects.toThrow(/aborted/i);
  });

  it("detects a cached-installer replacement before install", async () => {
    const original = Buffer.from("verified desktop installer");
    const artifact = windowsUpdateFixture("0.5.5", original);
    const path = join(await directory(), artifact.name);
    await writeFile(path, original);
    const verified = await verifyDownloadedArtifact(path, artifact);
    await writeFile(path, Buffer.from("replaced desktop installer"));
    await expect(reverifyDownloadedArtifact(verified)).rejects.toThrow(/changed|checksum|size/i);
  });

  it.runIf(process.platform !== "win32")("canonicalizes a stable symlinked cache ancestor but rejects a replaced leaf symlink", async () => {
    const bytes = Buffer.from("verified desktop installer");
    const artifact = darwinUpdateFixture("0.5.5", bytes);
    const root = await directory();
    const cache = join(root, "private-cache"), alias = join(root, "system-cache-alias");
    await mkdir(cache);
    await symlink(cache, alias, "dir");
    const verified = await downloadVerifiedArtifact(
      artifact,
      alias,
      async () => new Response(bytes, { status: 200 }),
    );
    expect(verified.path).toBe(join(await realpath(cache), artifact.name));
    await expect(reverifyDownloadedArtifact(verified)).resolves.toBe(verified.path);

    const replacement = join(root, "replacement.dmg");
    await writeFile(replacement, bytes);
    await rm(verified.path);
    await symlink(replacement, verified.path);
    await expect(reverifyDownloadedArtifact(verified)).rejects.toThrow(/ordinary file|identity|changed/i);
  });
});
