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
import {
  buildMacSafeStorageSeedArgs,
  buildMacKeychainConsentScript,
  findSafeStorageKeychainItem,
  launchWithRequiredConsent,
  macSafeStorageAccountName,
  parseSecurityKeychains,
  redactSecret,
} from "./native-update-mac-keychain.mjs";
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

test("scopes macOS Keychain consent to the exact app item and private keychain", () => {
  assert.equal(macSafeStorageAccountName("Multi Device Context"), "Multi Device Context Key");
  assert.throws(() => macSafeStorageAccountName("Multi Device Context\nOther"), /Invalid macOS app name/u);
  assert.deepEqual(parseSecurityKeychains(`    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/tmp/MDC Native Update Test.keychain-db"\n`), [
    "/Users/runner/Library/Keychains/login.keychain-db",
    "/tmp/MDC Native Update Test.keychain-db",
  ]);
  assert.throws(() => parseSecurityKeychains('"relative.keychain-db"\n'), /absolute/u);

  const script = buildMacKeychainConsentScript({
    appName: "Multi Device Context",
    serviceName: "Multi Device Context Safe Storage",
    keychainName: "MDC Native Update Test",
  });
  assert.match(script, /system attribute "MDC_NATIVE_UPDATE_KEYCHAIN_PASSWORD"/u);
  assert.match(script, /Multi Device Context Safe Storage/u);
  assert.match(script, /MDC Native Update Test/u);
  assert.match(script, /Multi Device Context wants to use/u);
  assert.match(script, /click button "Allow"/u);
  assert.doesNotMatch(script, /Always Allow/u);

  const item = findSafeStorageKeychainItem(`
keychain: "/tmp/MDC Native Update Test.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="Multi Device Context Key"
    "svce"<blob>="Multi Device Context Safe Storage"
keychain: "/tmp/MDC Native Update Test.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="unrelated"
    "svce"<blob>="Other Service"
`, "Multi Device Context Safe Storage");
  assert.deepEqual(item, {
    accountName: "Multi Device Context Key",
    serviceName: "Multi Device Context Safe Storage",
  });
  assert.throws(() => findSafeStorageKeychainItem(`class: "genp"\n`, "Multi Device Context Safe Storage"), /not found/u);

  assert.deepEqual(buildMacSafeStorageSeedArgs({
    accountName: item.accountName,
    serviceName: item.serviceName,
    password: "fixture-secret",
    trustedApplication: "/tmp/Applications/Multi Device Context.app/Contents/MacOS/Multi Device Context",
    keychainPath: "/tmp/MDC Native Update Test.keychain-db",
  }), [
    "add-generic-password",
    "-a", "Multi Device Context Key",
    "-s", "Multi Device Context Safe Storage",
    "-w", "fixture-secret",
    "-T", "/tmp/Applications/Multi Device Context.app/Contents/MacOS/Multi Device Context",
    "/tmp/MDC Native Update Test.keychain-db",
  ]);
});

test("owns the native application across launch and Keychain consent failures", async () => {
  let consentAborted = false, consentClosed = false, closeCalls = 0;
  await assert.rejects(launchWithRequiredConsent({
    launch: async () => { throw new Error("launch rejected"); },
    consent: signal => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        consentAborted = true;
        setTimeout(() => {
          consentClosed = true;
          reject(new Error("consent aborted and closed"));
        }, 10);
      }, { once: true });
    }),
    close: async () => { closeCalls += 1; },
  }), /launch rejected/u);
  assert.equal(consentAborted, true);
  assert.equal(consentClosed, true);
  assert.equal(closeCalls, 0);

  const launched = { id: "exact-b" };
  await assert.rejects(launchWithRequiredConsent({
    launch: async () => launched,
    consent: async () => { throw new Error("consent rejected"); },
    close: async value => { assert.equal(value, launched); closeCalls += 1; },
  }), /consent rejected/u);
  assert.equal(closeCalls, 1);

  await assert.rejects(launchWithRequiredConsent({
    launch: async () => launched,
    consent: async () => {},
    ready: async () => { throw new Error("first window rejected"); },
    close: async value => { assert.equal(value, launched); closeCalls += 1; },
  }), /first window rejected/u);
  assert.equal(closeCalls, 2);
});

test("redacts a private Keychain password from automation failures", () => {
  assert.equal(
    redactSecret("setter rejected value private-password twice: private-password", "private-password"),
    "setter rejected value [redacted] twice: [redacted]",
  );
});

test("rewrites only a private source copy and marks it so production validation rejects it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mdc-update-fixture-unit-"));
  const destination = join(parent, "source");
  const productionContracts = join(sourceRoot, "packages/contracts/src/updates.ts");
  const productionMain = join(sourceRoot, "apps/desktop/src/main.ts");
  const before = await hashFile(productionContracts);
  const mainBefore = await hashFile(productionMain);
  try {
    const result = await preparePrivateTestWorkspace({
      sourceRoot,
      destination,
      origin: "https://localhost:48765",
      appOrigin: "https://release.example.test",
      version: "0.5.3",
    });
    const copiedContracts = await readFile(join(destination, "packages/contracts/src/updates.ts"), "utf8");
    assert.match(copiedContracts, /https:\/\/localhost:48765\/updates\/preview\.json/);
    assert(!copiedContracts.includes("https://pbuchman.github.io/multi-device-context/updates/preview.json"));
    const manifest = JSON.parse(await readFile(join(result.appDirectory, "package.json"), "utf8"));
    assert.equal(manifest.mdcNativeUpdateTestOnly, TEST_FIXTURE_MARKER);
    const copiedMain = await readFile(join(result.appDirectory, "src/main.ts"), "utf8");
    assert.match(copiedMain, /NativeStore\.open\(directory, "https:\/\/release\.example\.test", hostname\(\), \{/u);
    assert.match(copiedMain, /isTrustedAppUrl\([^\n]+MDC_APP_ORIGIN/u);
    assert.equal(result.appOrigin, "https://release.example.test");
    assert.throws(() => assertProductionUpdateBoundary(
      manifest,
      "https://localhost:48765/updates/preview.json",
      "",
      JSON.stringify({ appOrigin: "https://localhost:48765", bridgeVersion: 1, nativeUpdateTestOnly: TEST_FIXTURE_MARKER }),
    ), /nativeUpdateTestOnly|test-only|deep-equal/i);
    assert.deepEqual(await hashFile(productionContracts), before);
    assert.deepEqual(await hashFile(productionMain), mainBefore);
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
