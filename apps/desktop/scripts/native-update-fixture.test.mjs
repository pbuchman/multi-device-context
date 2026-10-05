import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import test from "node:test";
import {
  TEST_FIXTURE_MARKER,
  buildTestCatalog,
  hashFile,
  preparePrivateTestWorkspace,
  previousVersion,
  readArchiveManifest,
} from "./native-update-fixture.mjs";
import { assertProductionUpdateBoundary } from "./production-update-boundary.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("reads the newly installed archive after A is replaced at the same path", async () => {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  const packager = createRequire(builder.resolve("app-builder-lib"));
  const asar = packager("@electron/asar");
  const parent = await mkdtemp(join(tmpdir(), "mdc-asar-replacement-"));
  const archive = join(parent, "app.asar");
  try {
    for (const version of ["1.0.0", "1.0.1"]) {
      const source = join(parent, version);
      await mkdir(source);
      await writeFile(join(source, "package.json"), JSON.stringify({ version }));
      if (version === "1.0.0") await writeFile(join(source, "before.txt"), "A-only content");
      await asar.createPackage(source, archive);
      assert.equal(readArchiveManifest(archive, asar).version, version);
    }
  } finally { asar.uncache(archive); await rm(parent, { recursive: true, force: true }); }
});

test("derives a strictly older numeric A version", () => {
  assert.equal(previousVersion("1.2.3"), "1.2.2");
  assert.equal(previousVersion("1.2.0"), "1.1.999999");
  assert.equal(previousVersion("1.0.0"), "0.999999.999999");
  assert.throws(() => previousVersion("0.0.0"));
});

test("builds an exact local catalog around the immutable selected B bytes", () => {
  const updateArtifact = { size: 123, sha256: "a".repeat(64), sha512: `${"A".repeat(86)}==` };
  const catalog = buildTestCatalog({ version: "2.0.0", repository: "https://localhost:48765/repository", platform: "win32", updateArtifact });
  assert.equal(catalog.artifacts.length, 3);
  const selected = catalog.artifacts.find(value => value.platform === "win32");
  assert.deepEqual(
    { name: selected.name, url: selected.url, size: selected.size, sha256: selected.sha256, sha512: selected.sha512 },
    {
      name: "Multi-Device-Context-2.0.0-win-x64.exe",
      url: "https://localhost:48765/repository/releases/download/v2.0.0/Multi-Device-Context-2.0.0-win-x64.exe",
      ...updateArtifact,
    },
  );
});

test("rewrites only a private source copy and marks it so production validation rejects it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mdc-update-fixture-unit-"));
  const destination = join(parent, "source");
  const productionContracts = join(sourceRoot, "packages/contracts/src/updates.ts");
  const before = await hashFile(productionContracts);
  try {
    const result = await preparePrivateTestWorkspace({
      sourceRoot,
      destination,
      origin: "https://localhost:48765",
      version: "0.5.3",
    });
    const copiedContracts = await readFile(join(destination, "packages/contracts/src/updates.ts"), "utf8");
    assert.match(copiedContracts, /https:\/\/localhost:48765\/updates\/preview\.json/);
    assert(!copiedContracts.includes("https://pbuchman.github.io/multi-device-context/updates/preview.json"));
    const manifest = JSON.parse(await readFile(join(result.appDirectory, "package.json"), "utf8"));
    assert.equal(manifest.mdcNativeUpdateTestOnly, TEST_FIXTURE_MARKER);
    assert.throws(() => assertProductionUpdateBoundary(
      manifest,
      "https://localhost:48765/updates/preview.json",
      "",
      JSON.stringify({ appOrigin: "https://localhost:48765", bridgeVersion: 1, nativeUpdateTestOnly: TEST_FIXTURE_MARKER }),
    ), /nativeUpdateTestOnly|test-only|deep-equal/i);
    assert.deepEqual(await hashFile(productionContracts), before);
    const output = join(parent, "download.mjs");
    await build({ entryPoints: [join(result.appDirectory, "src/update-files.ts")], outfile: output,
      bundle: true, platform: "node", format: "esm",
      alias: { "@mdc/contracts": join(destination, "packages/contracts/src/index.ts") } });
    const { downloadVerifiedArtifact } = await import(pathToFileURL(output).href);
    const bytes = Buffer.from("isolated macOS fixture");
    const catalog = buildTestCatalog({ version: "0.5.4", repository: result.repository, platform: "darwin",
      updateArtifact: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        sha512: createHash("sha512").update(bytes).digest("base64") } });
    const artifact = catalog.artifacts.find(value => value.platform === "darwin");
    const downloaded = await downloadVerifiedArtifact(artifact, join(parent, "cache"), async url => {
      assert.equal(url, artifact.url);
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    });
    assert.deepEqual(await readFile(downloaded.path), bytes);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
