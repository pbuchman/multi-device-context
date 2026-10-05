import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  MAX_UPDATE_ARTIFACT_BYTES,
  MAX_UPDATE_CATALOG_BYTES,
  UPDATE_CATALOG_URL,
  parseUpdateCatalog,
  type DarwinUpdateArtifact,
  type UpdateCatalog,
  type WindowsUpdateArtifact,
} from "@mdc/contracts";

export type DesktopUpdateArtifact = DarwinUpdateArtifact | WindowsUpdateArtifact;
export interface VerifiedUpdate {
  readonly artifact: DesktopUpdateArtifact;
  readonly path: string;
  readonly identity: string;
}
export type UpdateFetch = (input: string, init?: RequestInit) => Promise<Response>;

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error("Invalid update response size.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid update response size.");
  return parsed;
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = contentLength(response);
  if (declared !== undefined && declared > maximum) throw new Error("Update response is too large.");
  if (!response.body) throw new Error("Update response was empty.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of responseChunks(response.body)) {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > maximum) throw new Error("Update response is too large.");
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) return;
      yield value.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function fetchUpdateCatalog(fetcher: UpdateFetch = fetch): Promise<UpdateCatalog> {
  const response = await fetcher(UPDATE_CATALOG_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("The update catalog is unavailable.");
  const bytes = await readBoundedBody(response, MAX_UPDATE_CATALOG_BYTES);
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Update catalog must be valid UTF-8 JSON.");
  }
  return parseUpdateCatalog(serialized);
}

function approvedArtifactUrl(value: string, artifact: DesktopUpdateArtifact, redirected: boolean): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
    throw new Error("Unsafe update redirect.");
  if (!redirected) {
    if (url.href !== artifact.url) throw new Error("Unexpected update download URL.");
    return url;
  }
  if (!["release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"].includes(url.hostname))
    throw new Error("Unsafe update redirect.");
  return url;
}

async function responseForArtifact(
  artifact: DesktopUpdateArtifact,
  fetcher: UpdateFetch,
  signal: AbortSignal,
): Promise<Response> {
  let url = artifact.url;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    approvedArtifactUrl(url, artifact, redirect > 0);
    const response = await fetcher(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === 5) throw new Error("Too many update redirects.");
      const location = response.headers.get("location");
      if (!location) throw new Error("Invalid update redirect.");
      url = new URL(location, url).href;
      continue;
    }
    if (response.status !== 200) throw new Error("The update download failed.");
    const declared = contentLength(response);
    if (declared !== undefined && declared !== artifact.size)
      throw new Error("Update download size does not match the catalog.");
    return response;
  }
  throw new Error("Too many update redirects.");
}

function sameStat(left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, right: typeof left): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function verifyDownloadedArtifact(
  path: string,
  artifact: DesktopUpdateArtifact,
): Promise<VerifiedUpdate> {
  const absolute = resolve(path);
  const entry = await lstat(absolute);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("The cached update is not an ordinary file.");
  if (await realpath(absolute) !== absolute) throw new Error("The cached update path changed.");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(absolute, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== artifact.size)
      throw new Error("The cached update size changed.");
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAX_UPDATE_ARTIFACT_BYTES || offset > artifact.size)
        throw new Error("The cached update size changed.");
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk); sha512.update(chunk);
    }
    const after = await handle.stat();
    if (!sameStat(before, after) || offset !== artifact.size)
      throw new Error("The cached update changed during verification.");
    if (sha256.digest("hex") !== artifact.sha256 || sha512.digest("base64") !== artifact.sha512)
      throw new Error("The cached update checksum does not match the catalog.");
    const identity = JSON.stringify([
      absolute, String(after.dev), String(after.ino), after.size, after.mtimeMs, after.ctimeMs,
    ]);
    return { artifact: structuredClone(artifact), path: absolute, identity };
  } finally {
    await handle.close();
  }
}

export async function reverifyDownloadedArtifact(verified: VerifiedUpdate): Promise<string> {
  const current = await verifyDownloadedArtifact(verified.path, verified.artifact);
  if (current.identity !== verified.identity) throw new Error("The cached update identity changed.");
  return current.path;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
    if (bytesWritten <= 0) throw new Error("The update download could not be saved.");
    offset += bytesWritten;
  }
}

export async function downloadVerifiedArtifact(
  artifact: DesktopUpdateArtifact,
  cacheDirectory: string,
  fetcher: UpdateFetch = fetch,
  progress: (transferred: number, total: number) => void = () => {},
  timeoutMs = 15 * 60_000,
): Promise<VerifiedUpdate> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(cacheDirectory, 0o700).catch(() => {});
  const destination = join(cacheDirectory, artifact.name);
  if (dirname(destination) !== resolve(cacheDirectory)) throw new Error("Invalid update filename.");
  const partial = join(cacheDirectory, `.${artifact.name}.${randomUUID()}.part`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await responseForArtifact(artifact, fetcher, controller.signal);
    if (!response.body) throw new Error("Update response was empty.");
    handle = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let transferred = 0;
    for await (const value of responseChunks(response.body)) {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (transferred + chunk.byteLength > artifact.size || transferred + chunk.byteLength > MAX_UPDATE_ARTIFACT_BYTES)
        throw new Error("Update download size does not match the catalog.");
      await writeAll(handle, chunk, transferred);
      transferred += chunk.byteLength;
      progress(transferred, artifact.size);
    }
    await handle.sync();
    await handle.close(); handle = undefined;
    if (transferred !== artifact.size) throw new Error("Update download size does not match the catalog.");
    await verifyDownloadedArtifact(partial, artifact);
    await rm(destination, { force: true });
    await rename(partial, destination);
    return await verifyDownloadedArtifact(destination, artifact);
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
  }
}
