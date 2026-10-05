import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { basename, dirname, join } from "node:path";

export const TEST_FIXTURE_MARKER = "MDC_NATIVE_UPDATE_TEST_FIXTURE_DO_NOT_PUBLISH";

export function readArchiveManifest(archivePath, asar) {
  // NSIS and manual DMG replacement keep the archive pathname. Its cached
  // header belongs to A and must not be used to read B's different offsets.
  asar.uncache(archivePath);
  return JSON.parse(asar.extractFile(archivePath, "package.json").toString());
}

export async function hashFile(path) {
  const sha256 = createHash("sha256"), sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length; sha256.update(chunk); sha512.update(chunk);
  }
  return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

export function previousVersion(version) {
  assert.match(version, /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
  const [major, minor, patch] = version.split(".").map(Number);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.999999`;
  assert(major > 0, "Version 0.0.0 cannot have an A predecessor");
  return `${major - 1}.999999.999999`;
}

async function replaceExact(path, before, after) {
  const value = await readFile(path, "utf8");
  assert(value.includes(before), `Expected fixture source text in ${path}`);
  assert.equal(value.indexOf(before), value.lastIndexOf(before), `Fixture source text must be unique in ${path}`);
  await writeFile(path, value.replace(before, after));
}

async function directoryLink(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
}

export async function preparePrivateTestWorkspace({
  sourceRoot,
  destination,
  origin,
  appOrigin = origin,
  version,
}) {
  const appOriginUrl = new URL(appOrigin);
  assert.equal(appOriginUrl.protocol, "https:", "B application origin must use HTTPS");
  assert.equal(appOriginUrl.username, "", "B application origin must not include credentials");
  assert.equal(appOriginUrl.password, "", "B application origin must not include credentials");
  assert.equal(appOriginUrl.pathname, "/", "B application origin must not include a path");
  assert.equal(appOriginUrl.search, "", "B application origin must not include a query");
  assert.equal(appOriginUrl.hash, "", "B application origin must not include a fragment");
  assert.equal(appOriginUrl.origin, appOrigin, "B application origin must be canonical");
  assert.equal((await lstat(destination).catch(() => undefined)), undefined, "Private fixture destination already exists");
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const filter = source => !/[\\/](?:node_modules|bundle|dist|release|coverage|test-results|playwright-report)(?:[\\/]|$)/u.test(source);
  await cp(join(sourceRoot, "apps/desktop"), join(destination, "apps/desktop"), { recursive: true, filter });
  await cp(join(sourceRoot, "packages/contracts"), join(destination, "packages/contracts"), { recursive: true, filter });
  await cp(join(sourceRoot, "LICENSE"), join(destination, "LICENSE"));
  await cp(join(sourceRoot, "tsconfig.base.json"), join(destination, "tsconfig.base.json"));
  await directoryLink(join(sourceRoot, "apps/desktop/node_modules"), join(destination, "apps/desktop/node_modules"));
  await directoryLink(join(sourceRoot, "packages/contracts/node_modules"), join(destination, "packages/contracts/node_modules"));

  const contracts = join(destination, "packages/contracts/src/updates.ts");
  const repository = `${origin}/repository`;
  await replaceExact(
    contracts,
    '"https://pbuchman.github.io/multi-device-context/updates/preview.json"',
    `"${origin}/updates/preview.json"`,
  );
  await replaceExact(
    contracts,
    '"https://pbuchman.github.io/multi-device-context/updates/preview/"',
    `"${origin}/updates/preview/"`,
  );
  await replaceExact(
    contracts,
    'const RELEASE_REPOSITORY_URL = "https://github.com/pbuchman/multi-device-context";',
    `const RELEASE_REPOSITORY_URL = "${repository}";`,
  );
  // The private fixture needs its fixed localhost HTTPS port. Production keeps
  // rejecting every non-default artifact port; no runtime override is added.
  await replaceExact(
    join(destination, "apps/desktop/src/update-files.ts"),
    'url.protocol !== "https:" || url.username || url.password || url.port || url.hash',
    `url.protocol !== "https:" || url.username || url.password || (url.port && url.origin !== ${JSON.stringify(origin)}) || url.hash`,
  );
  // A uses the isolated localhost renderer and update feed, but writes the
  // private-state scope that exact B expects. This test-only source copy is
  // marked below and rejected by normal package validation.
  await replaceExact(
    join(destination, "apps/desktop/src/main.ts"),
    "store = await NativeStore.open(directory, MDC_APP_ORIGIN, hostname(), {",
    `store = await NativeStore.open(directory, ${JSON.stringify(appOrigin)}, hostname(), {`,
  );

  const packagePath = join(destination, "apps/desktop/package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.version = version;
  manifest.mdcNativeUpdateTestOnly = TEST_FIXTURE_MARKER;
  await writeFile(packagePath, JSON.stringify(manifest, null, 2) + "\n");

  const build = join(destination, "apps/desktop/scripts/build.mjs");
  await replaceExact(
    build,
    "    entryPoints: [`src/${name}.ts`],",
    '    alias: { "@mdc/contracts": "../../packages/contracts/src/index.ts" },\n    entryPoints: [`src/${name}.ts`],',
  );
  await replaceExact(
    build,
    "JSON.stringify({ appOrigin: origin, bridgeVersion: 1 }, null, 2)",
    `JSON.stringify({ appOrigin: origin, bridgeVersion: 1, nativeUpdateTestOnly: "${TEST_FIXTURE_MARKER}" }, null, 2)`,
  );
  const builder = join(destination, "apps/desktop/electron-builder.yml");
  await replaceExact(
    builder,
    "  url: https://pbuchman.github.io/multi-device-context/updates/preview/",
    `  url: ${origin}/updates/preview/`,
  );
  return { appDirectory: join(destination, "apps/desktop"), appOrigin, repository };
}

function artifact(platform, version, repository, bytes) {
  const suffix = platform === "darwin" ? "mac-arm64.dmg" : platform === "win32" ? "win-x64.exe" : "android-v1-release.apk";
  const name = `Multi-Device-Context-${version}-${suffix}`;
  return {
    platform,
    ...(platform === "darwin"
      ? { arch: "arm64", format: "dmg", minimumSystemVersion: "13.0.0" }
      : platform === "win32"
        ? { arch: "x64", format: "exe", minimumSystemVersion: "10.0.0" }
        : { arch: "universal", format: "apk", versionCode: 1, minimumSdk: 26 }),
    name,
    url: `${repository}/releases/download/v${version}/${name}`,
    ...bytes,
  };
}

export function buildTestCatalog({ version, repository, platform, updateArtifact }) {
  const placeholder = {
    size: 1,
    sha256: createHash("sha256").update("x").digest("hex"),
    sha512: createHash("sha512").update("x").digest("base64"),
  };
  const artifacts = ["darwin", "win32", "android"].map(candidate => artifact(
    candidate,
    version,
    repository,
    candidate === platform ? updateArtifact : placeholder,
  ));
  return {
    schemaVersion: 1,
    channel: "preview",
    version,
    commit: "b".repeat(40),
    publishedAt: "2026-10-05T00:00:00.000Z",
    releaseUrl: `${repository}/releases/tag/v${version}`,
    artifacts,
  };
}

function windowsFeed(catalog) {
  const value = catalog.artifacts.find(artifact => artifact.platform === "win32");
  return `version: ${catalog.version}\nfiles:\n  - url: ${value.url}\n    sha512: ${value.sha512}\n    size: ${value.size}\npath: ${value.url}\nsha512: ${value.sha512}\nreleaseDate: ${catalog.publishedAt}\n`;
}

export async function startFixtureServer({ port, certificatePath, keyPath, catalog, updatePath }) {
  const requests = [], selected = catalog.artifacts.find(value => value.platform === process.platform);
  assert(selected, "Catalog has no host-platform update");
  assert.equal(basename(updatePath), selected.name, "B artifact must retain its canonical release name");
  const catalogBody = Buffer.from(JSON.stringify(catalog) + "\n"), feedBody = Buffer.from(windowsFeed(catalog));
  const configBody = Buffer.from(JSON.stringify({
    appOrigin: `https://localhost:${port}`,
    auth0: { domain: "auth.example.invalid", audience: "fixture-audience", webClientId: "fixture-web", nativeClientId: "fixture-native", connection: "google-oauth2" },
    firebase: { apiKey: "fixture", authDomain: "firebase.example.invalid", projectId: "fixture", storageBucket: "fixture.example.invalid" },
    limits: { maxTextBytes: 262144, maxAttachmentBytes: 104857600 },
    bridgeVersion: 1,
  }));
  let artifactBytesServed = 0;
  const server = createServer({ cert: await readFile(certificatePath), key: await readFile(keyPath) }, async (request, response) => {
    const path = new URL(request.url ?? "/", `https://localhost:${port}`).pathname;
    requests.push({ method: request.method, path });
    const send = (status, type, body) => {
      response.writeHead(status, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (path === "/" || path === "/index.html") {
      send(200, "text/html; charset=utf-8", Buffer.from("<!doctype html><meta charset=utf-8><title>Native update fixture</title><main>Native update fixture</main>"));
    } else if (path === "/api/config") send(200, "application/json", configBody);
    else if (path === "/updates/preview.json") send(200, "application/json", catalogBody);
    else if (path === "/updates/preview/latest.yml") send(200, "text/yaml", feedBody);
    else if (path === new URL(selected.url).pathname && ["GET", "HEAD"].includes(request.method ?? "")) {
      const size = (await lstat(updatePath)).size;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": size, "cache-control": "no-store" });
      if (request.method === "HEAD") response.end();
      else {
        const stream = createReadStream(updatePath);
        stream.on("data", chunk => { artifactBytesServed += chunk.length; });
        stream.on("error", error => response.destroy(error));
        stream.pipe(response);
      }
    } else send(404, "text/plain", Buffer.from("not found"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const spki = createHash("sha256").update(createPublicKey(await readFile(certificatePath)).export({ type: "spki", format: "der" })).digest("base64");
  return {
    origin: `https://localhost:${port}`,
    spki,
    requests,
    artifactBytesServed: () => artifactBytesServed,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

export async function removePrivateWorkspace(path) {
  await rm(path, { recursive: true, force: true });
}
