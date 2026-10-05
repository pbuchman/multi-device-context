// Destructive only inside an ephemeral native CI runner. The production B
// artifact is immutable input; test A is built in a private copied workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEST_FIXTURE_MARKER,
  buildTestCatalog,
  hashFile,
  preparePrivateTestWorkspace,
  previousVersion,
  readArchiveManifest,
  removePrivateWorkspace,
  startFixtureServer,
} from "./native-update-fixture.mjs";
import {
  buildMacSafeStorageSeedArgs,
  buildMacKeychainConsentScript,
  findSafeStorageKeychainItem,
  launchWithRequiredConsent,
  parseSecurityKeychains,
  redactSecret,
} from "./native-update-mac-keychain.mjs";

assert.equal(process.env.CI, "true", "A→B native update acceptance is restricted to an ephemeral CI runner");
assert.equal(process.env.MDC_NATIVE_UPDATE_A_TO_B, "1", "Set MDC_NATIVE_UPDATE_A_TO_B=1 explicitly on the isolated native update job");
assert(["win32", "darwin"].includes(process.platform), "A→B native update acceptance requires Windows or macOS");
assert(process.platform !== "win32" || process.arch === "x64", "Windows A→B acceptance requires x64");
assert(process.platform !== "darwin" || process.arch === "arm64", "macOS A→B acceptance requires Apple Silicon");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDirectory, "../../..");
const desktopDirectory = join(sourceRoot, "apps/desktop");
const bPath = resolve(process.env.MDC_NATIVE_UPDATE_B_ARTIFACT ?? "");
const bVersion = process.env.MDC_NATIVE_UPDATE_B_VERSION ?? "";
const aVersion = previousVersion(bVersion);
const port = Number(process.env.MDC_NATIVE_UPDATE_TEST_PORT ?? "48765");
assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, "Invalid fixture HTTPS port");
const reportPath = resolve(process.env.MDC_NATIVE_UPDATE_REPORT ?? join(desktopDirectory, "release/native-update-a-to-b.json"));
const privateRoot = await realpath(await mkdtemp(join(tmpdir(), "mdc-native-update-a-to-b-")));
const macUserDataDirectory = process.platform === "darwin" ? join(privateRoot, "user-data") : undefined;
await mkdir(dirname(reportPath), { recursive: true });
const report = {
  platform: process.platform,
  architecture: process.arch,
  startedAt: new Date().toISOString(),
  versions: { a: aVersion, b: bVersion },
  checks: [],
};
let app, server, installedExecutable, macKeychain, mountedVolumes = [];

function checkpoint(message) {
  report.checks.push(message);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`A→B: ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const { deadlineMs = 600_000, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: "inherit", ...spawnOptions });
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`${basename(command)} exceeded its ${deadlineMs} ms deadline`));
    }, deadlineMs);
    child.once("error", error => { clearTimeout(deadline); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      code === 0 ? resolvePromise() : reject(new Error(`${basename(command)} failed (${signal ?? code})`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const { deadlineMs = 600_000, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    let stdout = "", stderr = "", processError, closeFallback, settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(closeFallback);
      callback();
    };
    const waitForClose = error => {
      processError ??= error;
      clearTimeout(deadline);
      child.kill();
      closeFallback ??= setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(processError));
      }, 5_000);
    };
    const deadline = setTimeout(() => {
      waitForClose(new Error(`${basename(command)} exceeded its ${deadlineMs} ms deadline`));
    }, deadlineMs);
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.once("error", waitForClose);
    child.once("close", (code, signal) => {
      finish(() => {
        if (processError) reject(processError);
        else if (code === 0) resolvePromise(stdout);
        else reject(new Error(`${basename(command)} failed (${signal ?? code}): ${stderr.slice(-2000)}`));
      });
    });
  });
}

async function expectFailure(command, args, options = {}) {
  try { await runCapture(command, args, options); } catch { return; }
  throw new Error("Production package validation unexpectedly accepted the test-only A build");
}

function installedArchive(executable) {
  return process.platform === "darwin"
    ? join(dirname(executable), "../Resources/app.asar")
    : join(dirname(executable), "resources/app.asar");
}

const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder"));
const packager = createRequire(builder.resolve("app-builder-lib"));
const asar = packager("@electron/asar");
function installedManifest(executable) {
  return readArchiveManifest(installedArchive(executable), asar);
}

async function waitForVersion(executable, version, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const manifest = installedManifest(executable);
      if (manifest.version === version) return manifest;
      lastError = new Error(`Installed version is still ${manifest.version}`);
    } catch (error) { lastError = error; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  throw lastError ?? new Error(`Timed out waiting for installed version ${version}`);
}

async function attachDmg(path, mountRoot) {
  await mkdir(mountRoot, { recursive: true });
  const output = await runCapture("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountRoot, path]);
  assert(output.includes(mountRoot), "hdiutil did not report the isolated mount point");
  mountedVolumes.push(mountRoot);
  return mountRoot;
}

async function detachVolumes() {
  for (const value of mountedVolumes.splice(0).reverse())
    await runCapture("hdiutil", ["detach", value, "-force"]).catch(() => {});
}

async function installA(aArtifact) {
  if (process.platform === "win32") {
    const installDirectory = join(privateRoot, "non-default", "Multi Device Context");
    await mkdir(dirname(installDirectory), { recursive: true });
    await run(aArtifact, ["/S", `/D=${installDirectory}`], { deadlineMs: 180_000 });
    return join(installDirectory, "Multi Device Context.exe");
  }
  const mount = await attachDmg(aArtifact, join(privateRoot, "mount-a"));
  const appPath = join(privateRoot, "Applications", "Multi Device Context.app");
  await mkdir(dirname(appPath), { recursive: true });
  await run("ditto", [join(mount, "Multi Device Context.app"), appPath]);
  await detachVolumes();
  return join(appPath, "Contents/MacOS/Multi Device Context");
}

async function replaceMacWithB(executable) {
  const mount = await attachDmg(bPath, join(privateRoot, "mount-b"));
  const appPath = resolve(dirname(executable), "../..");
  const sourceApp = join(mount, "Multi Device Context.app");
  const sourceExecutable = join(sourceApp, "Contents/MacOS/Multi Device Context");
  const sourceArchive = join(sourceApp, "Contents/Resources/app.asar");
  const sourceIdentity = {
    executable: await hashFile(sourceExecutable),
    archive: await hashFile(sourceArchive),
  };
  const previous = `${appPath}.test-a`;
  await rm(previous, { recursive: true, force: true });
  await rename(appPath, previous);
  try { await run("ditto", [sourceApp, appPath]); }
  catch (error) { await rename(previous, appPath); throw error; }
  await rm(previous, { recursive: true, force: true });
  assert.deepEqual(await hashFile(executable), sourceIdentity.executable, "Copied B executable differs from the exact mounted DMG");
  assert.deepEqual(await hashFile(installedArchive(executable)), sourceIdentity.archive, "Copied B archive differs from the exact mounted DMG");
  await runCapture("codesign", ["--verify", "--deep", "--strict", appPath], { deadlineMs: 30_000 });
  await detachVolumes();
  return sourceIdentity;
}

async function createMacTestKeychain(executable, appName) {
  if (process.platform !== "darwin") return undefined;
  assert(typeof appName === "string" && appName.length > 0, "The packaged macOS app name is missing");
  const priorDefault = parseSecurityKeychains(await runCapture("security", ["default-keychain", "-d", "user"], { deadlineMs: 10_000 }));
  assert.equal(priorDefault.length, 1, "macOS returned more than one default user Keychain");
  const priorSearch = parseSecurityKeychains(await runCapture("security", ["list-keychains", "-d", "user"], { deadlineMs: 10_000 }));
  const name = "MDC Native Update Test";
  const path = join(privateRoot, `${name}.keychain-db`);
  const password = randomBytes(24).toString("hex");
  const serviceName = `${appName} Safe Storage`;
  const state = { name, path, password, appName, serviceName, priorDefault: priorDefault[0], priorSearch, created: false };
  try {
    await run("security", ["create-keychain", "-p", password, path], { deadlineMs: 10_000 });
    state.created = true;
    await run("security", ["set-keychain-settings", "-lut", "21600", path], { deadlineMs: 10_000 });
    await run("security", ["unlock-keychain", "-p", password, path], { deadlineMs: 10_000 });
    await run("security", ["list-keychains", "-d", "user", "-s", path], { deadlineMs: 10_000 });
    await run("security", ["default-keychain", "-d", "user", "-s", path], { deadlineMs: 10_000 });
    assert.deepEqual(
      parseSecurityKeychains(await runCapture("security", ["list-keychains", "-d", "user"], { deadlineMs: 10_000 })),
      [path],
      "The private test Keychain is not the isolated user search list",
    );
    assert.deepEqual(
      parseSecurityKeychains(await runCapture("security", ["default-keychain", "-d", "user"], { deadlineMs: 10_000 })),
      [path],
      "The private test Keychain is not the user default",
    );
    await run("security", buildMacSafeStorageSeedArgs({
      accountName: appName,
      serviceName,
      password: randomBytes(16).toString("base64"),
      trustedApplication: executable,
      keychainPath: path,
    }), { deadlineMs: 10_000 });
    const dump = await runCapture("security", ["dump-keychain", path], { deadlineMs: 10_000 });
    state.safeStorageItem = findSafeStorageKeychainItem(dump, serviceName);
    assert.equal(state.safeStorageItem.accountName, appName, "The private Safe Storage item account differs from the packaged app name");
    return state;
  } catch (error) {
    try { await restoreMacTestKeychain(state); }
    catch (restoreError) {
      macKeychain = state;
      throw new AggregateError([error, restoreError], "Creating the private test Keychain failed and its prior state could not be fully restored");
    }
    throw error;
  }
}

async function restoreMacTestKeychain(state) {
  if (!state) return;
  assert.equal(dirname(state.path), privateRoot, "Refusing to delete a Keychain outside the private fixture root");
  assert.equal(basename(state.path), `${state.name}.keychain-db`, "Refusing to delete an unexpected Keychain");
  const failures = [];
  try { await run("security", ["list-keychains", "-d", "user", "-s", ...state.priorSearch], { deadlineMs: 10_000 }); }
  catch (error) { failures.push(error); }
  try { await run("security", ["default-keychain", "-d", "user", "-s", state.priorDefault], { deadlineMs: 10_000 }); }
  catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, "Could not restore the prior user Keychain configuration");
  assert.deepEqual(
    parseSecurityKeychains(await runCapture("security", ["list-keychains", "-d", "user"], { deadlineMs: 10_000 })),
    state.priorSearch,
    "The prior user Keychain search list was not restored exactly",
  );
  assert.deepEqual(
    parseSecurityKeychains(await runCapture("security", ["default-keychain", "-d", "user"], { deadlineMs: 10_000 })),
    [state.priorDefault],
    "The prior default user Keychain was not restored exactly",
  );
  if (state.created) await run("security", ["delete-keychain", state.path], { deadlineMs: 10_000 });
}

async function requireMacAccessibilityAutomation() {
  const output = await runCapture("osascript", ["-e", 'tell application "System Events" to return UI elements enabled'], { deadlineMs: 10_000 });
  assert.equal(output.trim(), "true", "The macOS runner has not granted Accessibility access needed to consent through the real Keychain prompt");
}

async function authorizeMacKeychainPrompt(state, signal) {
  assert(state && process.platform === "darwin", "Keychain consent is macOS-only");
  const script = buildMacKeychainConsentScript({
    appName: state.appName,
    serviceName: state.serviceName,
    keychainName: state.name,
  });
  let output;
  try {
    output = await runCapture("osascript", ["-e", script], {
      deadlineMs: 50_000,
      env: { ...process.env, MDC_NATIVE_UPDATE_KEYCHAIN_PASSWORD: state.password },
      signal,
    });
  } catch (error) {
    const message = redactSecret(error instanceof Error ? error.message : String(error), state.password);
    throw new Error(`macOS Keychain consent automation failed: ${message}`);
  }
  assert.equal(output.trim(), "allowed", "macOS did not confirm exact B's item-specific Keychain consent");
}

async function killAutoStartedWindowsB() {
  if (process.platform !== "win32") return;
  await runCapture("taskkill", ["/F", "/T", "/IM", "Multi Device Context.exe"]).catch(() => {});
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
}

async function uninstallWindowsFixture(required = false) {
  if (process.platform !== "win32" || !installedExecutable) return;
  const directory = dirname(installedExecutable);
  const uninstaller = (await readdir(directory).catch(() => []))
    .find(name => /^Uninstall .+\.exe$/iu.test(name));
  if (!uninstaller) {
    if (required) throw new Error("The isolated NSIS installation has no uninstaller; registry cleanup cannot be proven.");
    return;
  }
  await run(join(directory, uninstaller), ["/S"], { deadlineMs: 60_000 });
  const deadline = Date.now() + 60_000;
  let registryPending = false;
  while (Date.now() < deadline) {
    if (!await access(installedExecutable).then(() => true, () => false)) {
      const uninstallRegistry = await runCapture("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s"]);
      registryPending = uninstallRegistry.toLocaleLowerCase("en-US").includes(directory.toLocaleLowerCase("en-US"));
      if (!registryPending) {
        installedExecutable = undefined;
        return;
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw new Error(registryPending
    ? "The isolated NSIS uninstall registry still references the non-default test location."
    : "The isolated NSIS uninstaller did not remove the test installation.");
}

async function findOpenSsl() {
  const candidates = [
    process.env.MDC_OPENSSL,
    "openssl",
    ...(process.platform === "win32"
      ? [
          process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "usr", "bin", "openssl.exe"),
          process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "openssl.exe"),
        ]
      : ["/usr/bin/openssl"]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return { command: candidate, version: (await runCapture(candidate, ["version"])).trim() }; }
    catch {}
  }
  throw new Error("OpenSSL is required to generate the isolated localhost test certificate.");
}

async function containsMarkers(root, markers) {
  const found = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const value = await readFile(path).catch(() => undefined);
        if (!value || value.length > 64 * 1024 * 1024) continue;
        for (const marker of markers) {
          if (value.includes(Buffer.from(marker)) || value.includes(Buffer.from(marker, "utf16le"))) found.add(marker);
        }
      }
    }
  }
  await visit(root);
  return markers.every(marker => found.has(marker));
}

async function sampleMacLaunch(executable, samplePath) {
  const output = await runCapture("ps", ["-axo", "pid=,command="], { deadlineMs: 10_000 });
  const main = output.split("\n").map(line => line.match(/^\s*(\d+)\s+(.+)$/u)).find(match => {
    const command = match?.[2];
    return command === executable || command?.startsWith(`${executable} `);
  });
  if (!main) throw new Error("The exact B main process was not present for sampling");
  await run("sample", [main[1], "1", "1", "-file", samplePath], { deadlineMs: 10_000 });
}

async function captureMacLaunchDiagnostic(executable, screenshotPath) {
  const processes = await runCapture("ps", ["-axo", "pid=,ppid=,state=,etime=,comm="], { deadlineMs: 10_000 })
    .then(output => output.split("\n").filter(line => /Multi Device Context|SecurityAgent|CoreServicesUIAgent|UserNotificationCenter/iu.test(line)))
    .catch(error => [`Process inspection failed: ${error instanceof Error ? error.message : String(error)}`]);
  let screenshotError, sampleError;
  try { await run("screencapture", ["-x", screenshotPath], { deadlineMs: 10_000 }); }
  catch (error) { screenshotError = error instanceof Error ? error.message : String(error); }
  const samplePath = join(dirname(screenshotPath), "native-update-launch-sample.txt");
  try { await sampleMacLaunch(executable, samplePath); }
  catch (error) { sampleError = error instanceof Error ? error.message : String(error); }
  report.launchDiagnostic = {
    screenshot: screenshotError ? undefined : basename(screenshotPath),
    ...(screenshotError ? { screenshotError } : {}),
    sample: sampleError ? undefined : basename(samplePath),
    ...(sampleError ? { sampleError } : {}),
    processes,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}

async function closeTestApplication(currentApp) {
  let closeDeadline;
  const closed = await Promise.race([
    currentApp.close().then(() => true, () => false),
    new Promise(resolvePromise => { closeDeadline = setTimeout(() => resolvePromise(false), 20_000); }),
  ]);
  clearTimeout(closeDeadline);
  if (closed) return;
  currentApp.process().kill("SIGKILL");
  throw new Error("The test application did not close; its fixture process was terminated.");
}

async function launch(executable, playwright, environment, spki, diagnosticScreenshot, keychainConsent) {
  let diagnosticPromise, diagnosticTimer;
  if (process.platform === "darwin" && diagnosticScreenshot) {
    diagnosticTimer = setTimeout(() => {
      diagnosticPromise = captureMacLaunchDiagnostic(executable, diagnosticScreenshot);
    }, 15_000);
  }
  try {
    const launchApplication = () => playwright.launch({
      executablePath: executable,
      args: [
        `--ignore-certificate-errors-spki-list=${spki}`,
        ...(macUserDataDirectory ? [`--user-data-dir=${macUserDataDirectory}`] : []),
      ],
      env: environment,
      timeout: 60_000,
    });
    const owned = await launchWithRequiredConsent({
      launch: launchApplication,
      consent: keychainConsent
        ? signal => authorizeMacKeychainPrompt(keychainConsent, signal)
        : async () => {},
      ready: launched => launched.firstWindow({ timeout: 60_000 }),
      close: closeTestApplication,
    });
    return { launched: owned.application, window: owned.ready };
  } finally {
    clearTimeout(diagnosticTimer);
    await diagnosticPromise;
  }
}

async function waitForBridge(window, origin) {
  await window.waitForURL(url => url.origin === origin, { timeout: 60_000 });
  await window.waitForFunction(() => window.contextDesktop?.version === 1);
}

async function quitNormally(currentApp, window, flushMarker) {
  await window.evaluate(marker => {
    window.__nativeUpdateStop?.();
    window.__nativeUpdateStop = window.contextDesktop.onCommand(request => {
      if (request.command !== "quit") return;
      localStorage.setItem("mdc-test-lifecycle-flush", marker);
      void window.contextDesktop.completeCommand(request.id, true);
    });
  }, flushMarker);
  const closed = currentApp.waitForEvent("close", { timeout: 60_000 });
  await currentApp.evaluate(({ app: electronApp }) => electronApp.quit());
  await closed;
}

try {
  assert(bPath && bVersion, "MDC_NATIVE_UPDATE_B_ARTIFACT and MDC_NATIVE_UPDATE_B_VERSION are required");
  const expectedBName = `Multi-Device-Context-${bVersion}-${process.platform === "win32" ? "win-x64.exe" : "mac-arm64.dmg"}`;
  assert.equal(basename(bPath), expectedBName, "B must be the canonical release artifact, without copying or renaming");
  const productionSource = join(sourceRoot, "packages/contracts/src/updates.ts");
  const sourceBefore = await hashFile(productionSource), bBefore = await hashFile(bPath);
  assert(bBefore.size > 0 && bBefore.size <= 1_073_741_824, "B artifact violates the desktop update size bound");
  report.bArtifact = { name: expectedBName, ...bBefore };

  const origin = `https://localhost:${port}`, repository = `${origin}/repository`;
  const catalog = buildTestCatalog({ version: bVersion, repository, platform: process.platform, updateArtifact: bBefore });
  const certificatePath = join(privateRoot, "localhost.crt"), keyPath = join(privateRoot, "localhost.key");
  const opensslConfig = join(privateRoot, "openssl.cnf");
  await writeFile(opensslConfig, `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = v3\n[dn]\nCN = localhost\n[v3]\nsubjectAltName = DNS:localhost,IP:127.0.0.1\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,digitalSignature,keyEncipherment\n`);
  const openssl = await findOpenSsl(); report.openssl = openssl.version;
  await run(openssl.command, ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "30", "-config", opensslConfig, "-keyout", keyPath, "-out", certificatePath]);
  server = await startFixtureServer({ port, certificatePath, keyPath, catalog, updatePath: bPath });
  checkpoint("Fixture source is local HTTPS with a certificate-specific browser pin and no runtime URL override");

  const copiedWorkspace = join(privateRoot, "source");
  assert(process.env.MDC_APP_ORIGIN, "MDC_APP_ORIGIN must identify the exact B build configuration");
  const fixture = await preparePrivateTestWorkspace({
    sourceRoot,
    destination: copiedWorkspace,
    origin,
    appOrigin: process.env.MDC_APP_ORIGIN,
    version: aVersion,
  });
  assert.notEqual(fixture.appOrigin, origin, "Exact B must not use the isolated test origin");
  checkpoint("Marked test A uses exact B's private-state scope while its renderer and update feed remain isolated local HTTPS");
  const builderCli = require.resolve("electron-builder/cli.js");
  const buildEnvironment = {
    ...process.env,
    MDC_APP_ORIGIN: origin,
    NODE_EXTRA_CA_CERTS: certificatePath,
  };
  await run(process.execPath, ["scripts/build.mjs"], { cwd: fixture.appDirectory, env: buildEnvironment });
  await expectFailure(process.execPath, [join(desktopDirectory, "scripts/check-package.mjs"), "bundle"], { cwd: fixture.appDirectory, env: buildEnvironment });
  checkpoint("Standard production package validation rejects the marked test-A bundle");
  await run(process.execPath, [builderCli, "--config", "electron-builder.yml", process.platform === "win32" ? "--win" : "--mac", process.platform === "win32" ? "nsis" : "dmg", process.platform === "win32" ? "--x64" : "--arm64", "--publish", "never"], { cwd: fixture.appDirectory, env: buildEnvironment });
  const aArtifact = join(fixture.appDirectory, "release", `Multi-Device-Context-${aVersion}-${process.platform === "win32" ? "win-x64.exe" : "mac-arm64.dmg"}`);
  assert((await hashFile(aArtifact)).size > 0, "Test A package was not produced");
  checkpoint("Test A was built only in a private copied workspace and packaging was forced to --publish never");

  const executable = await installA(aArtifact); installedExecutable = executable;
  assert.equal(installedManifest(executable).version, aVersion);
  assert.equal(installedManifest(executable).mdcNativeUpdateTestOnly, TEST_FIXTURE_MARKER);
  report.installation = { nonDefault: process.platform === "win32", executable };
  checkpoint(process.platform === "win32" ? "Installed test A at a non-default per-user location" : "Mounted test-A DMG and copied the app into an isolated Applications directory");

  if (macUserDataDirectory) {
    await mkdir(macUserDataDirectory, { recursive: true });
    await requireMacAccessibilityAutomation();
    const appName = installedManifest(executable).productName;
    macKeychain = await createMacTestKeychain(executable, appName);
    report.macIsolation = {
      privateUserData: true,
      privateKeychain: true,
      accessibilityConsentAutomation: true,
      safeStorageItem: macKeychain.safeStorageItem,
    };
    checkpoint("Isolated Mac fixture data and Safe Storage in a private user-data directory and test Keychain");
  }

  const { _electron: playwright } = await import("playwright");
  const environment = { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath };
  ({ launched: app } = await launch(executable, playwright, environment, server.spki));
  let window = app.windows()[0];
  await waitForBridge(window, origin);
  const markers = [
    `mdc-native-update-draft-${Date.now()}`,
    `mdc-native-update-outbox-${Date.now()}`,
    `mdc-native-update-settings-${Date.now()}`,
  ];
  const nativeSentinel = `mdc-native-update-safe-storage-${Date.now()}`;
  const runtimeA = await app.evaluate(({ app: electronApp }) => {
    const userData = electronApp.getPath("userData");
    const path = process.getBuiltinModule("path").join(userData, "native-update-a-to-b.safe");
    return {
      name: electronApp.getName(), version: electronApp.getVersion(), executable: process.execPath, userData, sentinelPath: path,
      nativeStatePath: process.getBuiltinModule("path").join(userData, "private", "private-state.bin"),
    };
  });
  assert.equal(runtimeA.version, aVersion);
  if (macKeychain) assert.equal(runtimeA.name, macKeychain.appName, "Electron's runtime app name differs from the private Safe Storage item");
  assert.equal(resolve(runtimeA.executable), resolve(executable));
  if (macUserDataDirectory) assert.equal(await realpath(runtimeA.userData), await realpath(macUserDataDirectory));
  await app.evaluate(async ({ safeStorage }, { path, sentinel }) => {
    const fs = process.getBuiltinModule("fs").promises;
    await fs.writeFile(path, safeStorage.encryptString(sentinel));
  }, { path: runtimeA.sentinelPath, sentinel: nativeSentinel });
  if (macKeychain) {
    const dump = await runCapture("security", ["dump-keychain", macKeychain.path], { deadlineMs: 10_000 });
    assert.deepEqual(findSafeStorageKeychainItem(dump, macKeychain.serviceName), macKeychain.safeStorageItem);
  }
  await window.evaluate(values => {
    localStorage.setItem("mdc-test-draft", values[0]);
    localStorage.setItem("mdc-test-outbox", values[1]);
    localStorage.setItem("mdc-test-settings", values[2]);
  }, markers);
  const available = await window.evaluate(() => window.contextDesktop.checkForUpdates());
  assert.equal(available.status, "available"); assert.equal(available.availableVersion, bVersion);
  const ready = await window.evaluate(() => window.contextDesktop.startUpdate());
  assert.equal(ready.status, "ready");
  await quitNormally(app, window, "ordinary-quit-acknowledged"); app = undefined;
  assert.equal(installedManifest(executable).version, aVersion, "Ordinary Quit installed the cached update");
  assert(await containsMarkers(runtimeA.userData, markers), "Draft/outbox/settings fixture data did not flush before ordinary Quit");
  const nativeStateBefore = await hashFile(runtimeA.nativeStatePath);
  const nativeSentinelBefore = await hashFile(runtimeA.sentinelPath);
  checkpoint("Downloaded and verified B, then ordinary acknowledged Quit left A installed and flushed synthetic browser data");

  ({ launched: app, window } = await launch(executable, playwright, environment, server.spki));
  await waitForBridge(window, origin);
  assert.equal((await window.evaluate(() => window.contextDesktop.checkForUpdates())).status, "available");
  assert.equal((await window.evaluate(() => window.contextDesktop.startUpdate())).status, "ready");
  if (process.platform === "win32") {
    await window.evaluate(marker => {
      window.__nativeUpdateStop = window.contextDesktop.onCommand(request => {
        if (request.command !== "quit") return;
        localStorage.setItem("mdc-test-lifecycle-flush", marker);
        void window.contextDesktop.completeCommand(request.id, true);
      });
      void window.contextDesktop.installUpdate();
    }, "explicit-update-acknowledged");
    await app.waitForEvent("close", { timeout: 180_000 }); app = undefined;
    await waitForVersion(executable, bVersion);
    await killAutoStartedWindowsB();
    checkpoint("Explicit Update and restart used the renderer save acknowledgement and NSIS replaced A in place with B");
  } else {
    const opened = await window.evaluate(() => window.contextDesktop.installUpdate());
    assert.equal(opened, undefined);
    assert.equal((await window.evaluate(() => window.contextDesktop.getUpdateState())).status, "ready");
    await quitNormally(app, window, "manual-mac-quit-acknowledged"); app = undefined;
    report.macReplacement = await replaceMacWithB(executable);
    assert.equal(installedManifest(executable).version, bVersion);
    checkpoint("Opened the verified exact B DMG, then explicitly quit, mounted and hash-verified the manual B replacement at the same path");
  }

  ({ launched: app } = await launch(
    executable,
    playwright,
    environment,
    server.spki,
    join(dirname(reportPath), "native-update-launch.png"),
    macKeychain,
  ));
  if (macKeychain) checkpoint("Simulated the user's one-time Allow consent for exact B's Safe Storage item in the private test Keychain");
  const bWindow = app.windows()[0];
  await bWindow.waitForLoadState("domcontentloaded");
  const runtimeBIdentity = await app.evaluate(({ app: electronApp }) => ({
    name: electronApp.getName(),
    version: electronApp.getVersion(),
    executable: process.execPath,
    userData: electronApp.getPath("userData"),
  }));
  if (macKeychain) assert.equal(runtimeBIdentity.name, macKeychain.appName, "Exact B changed the Safe Storage app identity");
  assert.deepEqual(
    { version: runtimeBIdentity.version, executable: resolve(runtimeBIdentity.executable), userData: runtimeBIdentity.userData },
    { version: bVersion, executable: resolve(executable), userData: runtimeA.userData },
  );
  if (macUserDataDirectory) assert.equal(await realpath(runtimeBIdentity.userData), await realpath(macUserDataDirectory));
  const sentinel = await app.evaluate(async ({ safeStorage }, path) => {
    const fs = process.getBuiltinModule("fs").promises;
    return safeStorage.decryptString(await fs.readFile(path));
  }, runtimeA.sentinelPath);
  assert.equal(sentinel, nativeSentinel);
  assert.deepEqual(await hashFile(runtimeA.nativeStatePath), nativeStateBefore, "Encrypted native startup state changed during A→B");
  assert.deepEqual(await hashFile(runtimeA.sentinelPath), nativeSentinelBefore, "Safe Storage ciphertext changed during Keychain consent");
  assert(await containsMarkers(runtimeBIdentity.userData, markers), "Synthetic draft/outbox/settings sentinels did not survive A→B");
  checkpoint("Restarted exact B at the same path; safeStorage, user-data path, draft, outbox and settings sentinels survived");
  if (process.platform === "win32") await app.evaluate(({ app: electronApp }) => electronApp.setLoginItemSettings({ openAtLogin: false, args: ["--background"] }));
  await app.close(); app = undefined;

  if (process.platform === "win32") {
    await uninstallWindowsFixture(true);
    checkpoint("Ran the isolated NSIS uninstaller and removed the non-default test installation before the normal B install");
  }

  const bAfter = await hashFile(bPath), sourceAfter = await hashFile(productionSource);
  assert.deepEqual(bAfter, bBefore, "Release B artifact changed during A→B acceptance");
  assert.deepEqual(sourceAfter, sourceBefore, "Production update constants changed during A→B acceptance");
  assert(server.artifactBytesServed() >= bBefore.size, "Fixture server never delivered the exact B payload");
  assert.equal(server.artifactBytesServed() % bBefore.size, 0, "Fixture server delivered a partial B payload");
  checkpoint("Release B and production source remained byte-for-byte unchanged; local HTTPS served only complete exact-B payloads");
  report.fixtureRequests = server.requests;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (app) {
    try { await closeTestApplication(app); }
    catch (error) {
      report.passed = false; process.exitCode = 1;
      report.cleanupFailure = error instanceof Error ? error.message : String(error);
    }
  }
  await detachVolumes();
  await server?.close().catch(() => {});
  try { await uninstallWindowsFixture(false); }
  catch (error) {
    report.passed = false; process.exitCode = 1;
    report.cleanupFailure = error instanceof Error ? error.message : String(error);
  }
  if (macKeychain) {
    try {
      await restoreMacTestKeychain(macKeychain);
      macKeychain = undefined;
      report.macIsolationRestored = true;
    } catch (error) {
      report.passed = false; process.exitCode = 1;
      report.cleanupFailure = error instanceof Error ? error.message : String(error);
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (process.env.MDC_KEEP_NATIVE_UPDATE_FIXTURE !== "1" && !macKeychain) await removePrivateWorkspace(privateRoot);
  console.log(JSON.stringify(report, null, 2));
}
