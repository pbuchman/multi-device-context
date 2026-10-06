// This changes LocalMachine\\Root only on an ephemeral Windows GitHub runner.
// The already-administrative runner uses the machine store; CurrentUser Root
// requires interactive Windows consent. No user workstation is modified.
// The generated CA is unique to this run, asserted absent first, and removed by
// exact thumbprint in finally. No production certificate or TLS override is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  buildWindowsRootCertificateCountScript,
  classifyNodeCertificateError,
  nodeErrorEvidence,
  normalizeThumbprint,
  parseOutputArgument,
  sanitizedFailure,
} from "./native-system-trust-helpers.mjs";

const COMMAND_DEADLINE_MS = 20_000;
const FETCH_DEADLINE_MS = 10_000;
const ELECTRON_DEADLINE_MS = 45_000;
const BUILD_DEADLINE_MS = 30_000;
const AUTHORIZATION = "Bearer native-system-trust-fixture";

function withDeadline(promise, deadlineMs, description, onDeadline) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onDeadline?.();
        reject(new Error(`${description} exceeded its ${deadlineMs} ms deadline`));
      }, deadlineMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
  } else child.kill("SIGKILL");
}

function runCapture(command, args, {
  deadlineMs = COMMAND_DEADLINE_MS,
  cwd,
  env,
  includeStderr = false,
  stderrRedactions = [],
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;
    let pendingError;
    let closeFallback;
    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(closeFallback);
      callback();
    };
    const terminate = error => {
      pendingError ??= error;
      clearTimeout(deadline);
      terminateProcessTree(child);
      closeFallback ??= setTimeout(() => finish(() => reject(pendingError)), 5_000);
    };
    const deadline = setTimeout(() => {
      terminate(new Error(`${basename(command)} exceeded its ${deadlineMs} ms deadline`));
    }, deadlineMs);
    child.stdout.on("data", value => {
      stdout += value;
      if (stdout.length > 1024 * 1024) {
        terminate(new Error(`${basename(command)} produced excessive output`));
      }
    });
    child.stderr.on("data", value => {
      stderrBytes += value.length;
      if (includeStderr && stderr.length < 2_000) stderr += value.toString("utf8").slice(0, 2_000 - stderr.length);
    });
    child.once("error", error => terminate(new Error(`${basename(command)} could not start: ${error.code ?? error.name}`)));
    child.once("close", (code, signal) => finish(() => {
      if (pendingError) reject(pendingError);
      else if (code === 0) resolvePromise(stdout);
      else {
        const detail = includeStderr && stderr.trim()
          ? sanitizedFailure(stderr, stderrRedactions).message
          : `${stderrBytes} stderr bytes`;
        reject(new Error(`${basename(command)} failed (${signal ?? code}): ${detail}`));
      }
    }));
  });
}

async function fileFingerprint(path) {
  const bytes = await readFile(path);
  return {
    name: basename(path),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function findOpenSsl() {
  const candidates = [
    process.env.MDC_OPENSSL,
    "openssl",
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "usr", "bin", "openssl.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "openssl.exe"),
  ].filter(Boolean);
  for (const command of candidates) {
    try {
      const version = (await runCapture(command, ["version"])).trim();
      if (/^OpenSSL\s/u.test(version)) return command;
    } catch {}
  }
  throw new Error("OpenSSL is required to generate the isolated localhost certificate");
}

async function generateCertificates(openSsl, fixtureRoot) {
  const caKey = join(fixtureRoot, "fixture-ca.key");
  const caCertificate = join(fixtureRoot, "fixture-ca.cer");
  const serverKey = join(fixtureRoot, "localhost.key");
  const serverRequest = join(fixtureRoot, "localhost.csr");
  const serverCertificate = join(fixtureRoot, "localhost.cer");
  const extensions = join(fixtureRoot, "localhost.ext");
  const uniqueName = `MDC Native System Trust CI ${randomUUID()}`;

  await writeFile(extensions, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:localhost",
    "",
  ].join("\n"));
  await runCapture(openSsl, ["genrsa", "-out", caKey, "2048"]);
  await runCapture(openSsl, [
    "req", "-x509", "-new", "-sha256", "-days", "1", "-key", caKey,
    "-out", caCertificate, "-subj", `/CN=${uniqueName}`,
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await runCapture(openSsl, ["genrsa", "-out", serverKey, "2048"]);
  await runCapture(openSsl, [
    "req", "-new", "-sha256", "-key", serverKey, "-out", serverRequest,
    "-subj", "/CN=localhost",
  ]);
  await runCapture(openSsl, [
    "x509", "-req", "-sha256", "-days", "1", "-in", serverRequest,
    "-CA", caCertificate, "-CAkey", caKey, "-CAcreateserial",
    "-out", serverCertificate, "-extfile", extensions,
  ]);
  const certificate = new X509Certificate(await readFile(caCertificate));
  return {
    caCertificate,
    serverCertificate,
    serverKey,
    thumbprint: normalizeThumbprint(certificate.fingerprint),
  };
}

async function rootCertificateCount(thumbprint) {
  const script = buildWindowsRootCertificateCountScript(thumbprint);
  const output = await runCapture("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], { includeStderr: true, stderrRedactions: [thumbprint] });
  const count = Number(output.trim());
  assert(Number.isSafeInteger(count) && count >= 0, "Could not count the generated CA in LocalMachine Root");
  return count;
}

async function startHttpsFixture(certificatePath, keyPath) {
  const requests = [];
  const sockets = new Set();
  const server = createServer({
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  }, (request, response) => {
    const path = new URL(request.url ?? "/", "https://localhost").pathname;
    const authorized = request.headers.authorization === AUTHORIZATION;
    requests.push({ path, authorized });
    if (!authorized) {
      response.writeHead(401, { "content-type": "text/plain", "connection": "close" });
      response.end("missing fixture authorization");
    } else if (path === "/redirect") {
      response.writeHead(302, { location: "/ok", "cache-control": "no-store" });
      response.end();
    } else if (path === "/ok") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("system trust ok");
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await withDeadline(new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "::", ipv6Only: false }, resolvePromise);
  }), COMMAND_DEADLINE_MS, "HTTPS fixture startup", () => server.close());
  const address = server.address();
  assert(address && typeof address === "object", "HTTPS fixture has no TCP address");
  return {
    localhostUrl: `https://localhost:${address.port}/redirect`,
    wrongHostUrl: `https://127.0.0.1:${address.port}/redirect`,
    requests,
    close: () => withDeadline(new Promise((resolvePromise, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close(error => error ? reject(error) : resolvePromise());
    }), COMMAND_DEADLINE_MS, "HTTPS fixture shutdown", () => {
      for (const socket of sockets) socket.destroy();
    }),
  };
}

export function probeEntrySource() {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "native-system-trust-helpers.mjs");
  return `
const { desktopFetch } = require("./src/network.ts");
const { classifyChromiumCertificateError } = require(${JSON.stringify(helperPath)});

async function runSystemTrustProbe(url) {
  let result;
  try {
    const response = await desktopFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(${FETCH_DEADLINE_MS}),
      headers: { Authorization: ${JSON.stringify(AUTHORIZATION)} },
    });
    const body = await response.text();
    const manualRedirect = await desktopFetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(${FETCH_DEADLINE_MS}),
      headers: { Authorization: ${JSON.stringify(AUTHORIZATION)} },
    });
    const manualLocation = manualRedirect.headers.get("location");
    const manualStream = await desktopFetch(new URL("/ok", url), {
      redirect: "manual",
      signal: AbortSignal.timeout(${FETCH_DEADLINE_MS}),
      headers: { Authorization: ${JSON.stringify(AUTHORIZATION)} },
    });
    result = {
      ok: true,
      status: response.status,
      body,
      manualRedirect: {
        status: manualRedirect.status,
        locationPath: manualLocation ? new URL(manualLocation, url).pathname : undefined,
      },
      manualStream: {
        status: manualStream.status,
        body: await manualStream.text(),
      },
    };
  } catch (error) {
    result = {
      ok: false,
      certificateError: classifyChromiumCertificateError(error),
    };
  }
  return result;
}
module.exports = { runSystemTrustProbe };
`;
}

export async function compileElectronProbe(desktopDirectory, outputPath) {
  const networkPath = join(desktopDirectory, "src/network.ts");
  await readFile(networkPath);
  await withDeadline(build({
    stdin: {
      contents: probeEntrySource(),
      resolveDir: desktopDirectory,
      sourcefile: "native-system-trust-probe.cjs",
      loader: "js",
    },
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    logLevel: "silent",
  }), BUILD_DEADLINE_MS, "network.ts acceptance bundle build");
}

export function packagedElectronExecutable(desktopDirectory) {
  return join(desktopDirectory, "release", "win-unpacked", "Multi Device Context.exe");
}

export function buildElectronProbeExpression(bundlePath, url) {
  assert(isAbsolute(bundlePath), "Electron probe bundle path must be absolute");
  return `(async () => {
    const { app, BrowserWindow } = require("electron");
    await app.whenReady();
    const windowDeadline = Date.now() + ${ELECTRON_DEADLINE_MS};
    while (BrowserWindow.getAllWindows().length === 0 && Date.now() < windowDeadline)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    if (BrowserWindow.getAllWindows().length === 0)
      throw new Error("Packaged application did not finish startup");
    let result;
    try {
      const { createRequire: createMainRequire } = process.getBuiltinModule("module");
      const probe = createMainRequire(${JSON.stringify(bundlePath)})(${JSON.stringify(bundlePath)});
      result = await probe.runSystemTrustProbe(${JSON.stringify(url)});
    } finally {
      app.setLoginItemSettings({ openAtLogin: false, args: ["--background"] });
    }
    return {
      result,
      runtime: {
        electronVersion: process.versions.electron,
        executablePath: process.execPath,
        userDataPath: app.getPath("userData"),
        packagedApplication: app.isPackaged,
        loginItemDisabled: !app.getLoginItemSettings({
          path: \`"\${process.execPath}"\`,
          args: ["--background"],
        }).openAtLogin,
      },
    };
  })()`;
}

export function parseElectronPhaseArguments(arguments_) {
  assert.equal(arguments_.length, 11, "Expected exact phase-controller arguments");
  assert.equal(arguments_[0], "--native-system-trust-phase", "Expected exact phase-controller arguments");
  const expectedNames = ["--electron", "--bundle", "--url", "--user-data", "--result"];
  const values = {};
  for (let index = 0; index < expectedNames.length; index += 1) {
    const argumentIndex = 1 + index * 2;
    assert.equal(arguments_[argumentIndex], expectedNames[index], "Expected exact phase-controller arguments");
    assert(arguments_[argumentIndex + 1], "Expected exact phase-controller arguments");
    values[expectedNames[index]] = arguments_[argumentIndex + 1];
  }
  const result = {
    electronPath: values["--electron"],
    bundlePath: values["--bundle"],
    url: values["--url"],
    userDataPath: values["--user-data"],
    resultPath: values["--result"],
  };
  for (const path of [result.electronPath, result.bundlePath, result.userDataPath, result.resultPath]) {
    assert(isAbsolute(path), "Phase-controller paths must be absolute");
  }
  const parsedUrl = new URL(result.url);
  assert(
    parsedUrl.protocol === "https:" && ["localhost", "127.0.0.1"].includes(parsedUrl.hostname),
    "Phase controller requires loopback HTTPS",
  );
  return result;
}

async function closeElectronApplication(application) {
  const { child, inspector } = application;
  if (inspector) {
    await inspector.send("Runtime.evaluate", {
      expression: "require('electron').app.exit(0)",
      includeCommandLineAPI: true,
    }, 5_000).catch(() => {});
    inspector.close();
  }
  if (child.exitCode !== null) return;
  let closeTimer;
  const closed = await Promise.race([
    new Promise(resolvePromise => child.once("close", () => resolvePromise(true))),
    new Promise(resolvePromise => { closeTimer = setTimeout(() => resolvePromise(false), 10_000); }),
  ]);
  clearTimeout(closeTimer);
  if (closed) return;
  terminateProcessTree(child);
  let terminateTimer;
  const terminated = child.exitCode !== null || await Promise.race([
    new Promise(resolvePromise => child.once("close", () => resolvePromise(true))),
    new Promise(resolvePromise => { terminateTimer = setTimeout(() => resolvePromise(false), 5_000); }),
  ]);
  clearTimeout(terminateTimer);
  throw new Error(terminated
    ? "The packaged Electron phase required forced termination"
    : "The packaged Electron phase could not be terminated");
}

function launchPackagedElectron(electronPath, userDataPath) {
  const electronEnvironment = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
  delete electronEnvironment.ELECTRON_RUN_AS_NODE;
  delete electronEnvironment.NODE_OPTIONS;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronPath, [
      "--inspect=0",
      `--user-data-dir=${userDataPath}`,
      "--enable-logging=stderr",
    ], {
      env: electronEnvironment,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finish = callback => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const detail = () => stderr.trim() || `${stderrBytes} stderr bytes`;
    const onError = error => finish(() => reject(new Error(`Packaged Electron could not start: ${error.code ?? error.name}`)));
    const onClose = (code, signal) => finish(() => reject(new Error(`Packaged Electron exited before inspection (${signal ?? code}): ${detail()}`)));
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error(`Packaged Electron did not expose its inspector: ${detail()}`);
      terminateProcessTree(child);
      if (child.exitCode !== null) { reject(error); return; }
      const terminateFallback = setTimeout(() => reject(error), 5_000);
      child.once("close", () => { clearTimeout(terminateFallback); reject(error); });
    }, ELECTRON_DEADLINE_MS);
    child.once("error", onError);
    child.once("close", onClose);
    child.stderr.on("data", value => {
      stderrBytes += value.length;
      if (stderr.length < 2_000) stderr += value.toString("utf8").slice(0, 2_000 - stderr.length);
      const match = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/u);
      if (match) finish(() => resolvePromise({ child, inspectorUrl: match[1] }));
    });
  });
}

async function connectElectronInspector(url) {
  const socket = new WebSocket(url);
  await withDeadline(new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to packaged Electron inspector")), { once: true });
  }), COMMAND_DEADLINE_MS, "Packaged Electron inspector connection", () => socket.close());
  let nextId = 0;
  return {
    send(method, params = {}, deadlineMs = ELECTRON_DEADLINE_MS) {
      const id = ++nextId;
      return withDeadline(new Promise((resolvePromise, reject) => {
        const cleanup = () => {
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("close", onClose);
          socket.removeEventListener("error", onError);
        };
        const onMessage = event => {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          cleanup();
          if (message.error) reject(new Error(`Electron inspector ${method} failed: ${message.error.message}`));
          else resolvePromise(message.result);
        };
        const onClose = () => { cleanup(); reject(new Error("Packaged Electron inspector closed unexpectedly")); };
        const onError = () => { cleanup(); reject(new Error("Packaged Electron inspector failed")); };
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.send(JSON.stringify({ id, method, params }));
      }), deadlineMs, `Electron inspector ${method}`, () => socket.close());
    },
    close() { socket.close(); },
  };
}

async function runElectronPhaseController(arguments_) {
  const { electronPath, bundlePath, url, userDataPath, resultPath } = parseElectronPhaseArguments(arguments_);
  let application;
  let primaryFailure;
  try {
    application = await launchPackagedElectron(electronPath, userDataPath);
    application.inspector = await connectElectronInspector(application.inspectorUrl);
    await application.inspector.send("Runtime.enable");
    const evaluation = await application.inspector.send("Runtime.evaluate", {
      expression: buildElectronProbeExpression(bundlePath, url),
      includeCommandLineAPI: true,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails) {
      const detail = evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text;
      throw new Error(`Packaged Electron probe failed: ${detail}`);
    }
    const output = evaluation.result?.value;
    assert(output && typeof output === "object", "Packaged Electron probe returned no result");
    assert.equal(output.runtime.electronVersion, "44.5.1", "Packaged acceptance runtime did not use Electron 44.5.1");
    assert.equal(output.runtime.packagedApplication, true, "Acceptance probe did not run inside a packaged application");
    assert.equal(
      resolve(output.runtime.executablePath).toLocaleLowerCase("en-US"),
      resolve(electronPath).toLocaleLowerCase("en-US"),
      "The inspector did not evaluate the selected packaged executable",
    );
    assert.equal(
      (await realpath(output.runtime.userDataPath)).toLocaleLowerCase("en-US"),
      (await realpath(userDataPath)).toLocaleLowerCase("en-US"),
      "Packaged acceptance runtime did not use the owned phase profile",
    );
    assert.equal(output.runtime.loginItemDisabled, true, "Packaged acceptance runtime left its login item enabled");
    await writeFile(resultPath, JSON.stringify({
      result: output.result,
      runtime: {
        electronVersion: output.runtime.electronVersion,
        packagedExecutableOwned: true,
        packagedApplication: true,
        userDataOwned: true,
        loginItemDisabled: true,
      },
    }));
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (application) {
      try { await closeElectronApplication(application); }
      catch (error) { if (!primaryFailure) throw error; }
    }
  }
}

async function launchElectronPhase({ electronPath, bundlePath, fixtureRoot, name, url }) {
  const userDataPath = join(fixtureRoot, `user-data-${name}`);
  const resultPath = join(fixtureRoot, `result-${name}.json`);
  await mkdir(userDataPath, { recursive: true });
  await runCapture(process.execPath, [
    fileURLToPath(import.meta.url),
    "--native-system-trust-phase",
    "--electron", electronPath,
    "--bundle", bundlePath,
    "--url", url,
    "--user-data", userDataPath,
    "--result", resultPath,
  ], {
    deadlineMs: ELECTRON_DEADLINE_MS * 2 + 15_000,
    cwd: dirname(fileURLToPath(import.meta.url)),
    includeStderr: true,
    stderrRedactions: [fixtureRoot, AUTHORIZATION],
  });
  const output = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(typeof output.result?.ok, "boolean", `Electron ${name} phase did not return a result`);
  assert.deepEqual(output.runtime, {
    electronVersion: "44.5.1",
    packagedExecutableOwned: true,
    packagedApplication: true,
    userDataOwned: true,
    loginItemDisabled: true,
  }, `Electron ${name} phase did not use the owned packaged runtime`);
  return output.result;
}

async function nodeFetchCertificateError(url) {
  try {
    await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_DEADLINE_MS),
      headers: { Authorization: AUTHORIZATION },
    });
  } catch (error) {
    return {
      certificateError: classifyNodeCertificateError(error),
      evidence: nodeErrorEvidence(error),
    };
  }
  return { certificateError: undefined, evidence: [] };
}

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}

export async function main(arguments_ = process.argv.slice(2)) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Native system trust acceptance is restricted to GitHub Actions");
  assert.equal(process.env.CI, "true", "Native system trust acceptance requires an ephemeral CI runner");
  assert.equal(process.platform, "win32", "Native system trust acceptance requires Windows");
  assert.equal(process.arch, "x64", "Native system trust acceptance requires Windows x64");

  const reportPath = parseOutputArgument(arguments_);
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const desktopDirectory = resolve(scriptDirectory, "..");
  const fixtureRoot = await mkdtemp(join(tmpdir(), "mdc-native-system-trust-"));
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    startedAt: new Date().toISOString(),
    checks: [],
    phases: {},
    cleanup: {
      certificateAbsentInitially: false,
      certificateRemoved: false,
      packagedRuntimeUnchanged: false,
      serverClosed: false,
      temporaryFilesRemoved: false,
    },
  };
  let certificate;
  let certificateStoreTouched = false;
  let packagedRuntimeBefore;
  let packagedRuntimePaths;
  let server;
  let primaryFailure;
  const cleanupFailures = [];
  const checkpoint = async message => {
    report.checks.push(message);
    await writeReport(reportPath, report);
    console.log(`Native system trust: ${message}`);
  };

  await writeReport(reportPath, report);
  try {
    const require = createRequire(import.meta.url);
    const electronMetadata = JSON.parse(await readFile(require.resolve("electron/package.json"), "utf8"));
    assert.equal(electronMetadata.version, "44.5.1", "The acceptance test requires pinned Electron 44.5.1");
    report.electronVersion = electronMetadata.version;
    const electronPath = packagedElectronExecutable(desktopDirectory);
    const archivePath = join(dirname(electronPath), "resources", "app.asar");
    await Promise.all([access(electronPath), access(archivePath)]);
    packagedRuntimePaths = { electronPath, archivePath };
    packagedRuntimeBefore = {
      executable: await fileFingerprint(electronPath),
      applicationArchive: await fileFingerprint(archivePath),
    };
    report.packagedRuntime = {
      source: "electron-builder win-unpacked output",
      artifacts: packagedRuntimeBefore,
      networkProbe: {
        source: "apps/desktop/src/network.ts",
        separatelyBundled: true,
      },
      phaseProfiles: "fresh owned fixture directory per phase",
    };
    await checkpoint("Selected the packaged Electron 44.5.1 runtime and recorded its executable and ASAR fingerprints");

    const openSsl = await findOpenSsl();
    certificate = await generateCertificates(openSsl, fixtureRoot);
    assert.equal(await rootCertificateCount(certificate.thumbprint), 0, "Generated CA already exists in LocalMachine Root");
    report.cleanup.certificateAbsentInitially = true;
    await checkpoint("Generated a unique localhost CA and confirmed it was absent from LocalMachine Root");

    server = await startHttpsFixture(certificate.serverCertificate, certificate.serverKey);
    const bundlePath = join(fixtureRoot, "native-system-trust-probe.cjs");
    await compileElectronProbe(desktopDirectory, bundlePath);
    await checkpoint("Compiled the production network.ts through the installed esbuild");

    const nodeBeforeTrust = await nodeFetchCertificateError(server.localhostUrl);
    report.phases.beforeTrust = {
      nodeFetch: {
        ...(nodeBeforeTrust.certificateError ? { certificateError: nodeBeforeTrust.certificateError } : {}),
        evidence: nodeBeforeTrust.evidence,
      },
    };
    assert(nodeBeforeTrust.certificateError, "Node fetch did not fail with a recognized untrusted-certificate code before installation");
    const beforeTrust = await launchElectronPhase({
      electronPath, bundlePath, fixtureRoot, name: "before-trust", url: server.localhostUrl,
    });
    assert.deepEqual(
      beforeTrust,
      { ok: false, certificateError: "ERR_CERT_AUTHORITY_INVALID" },
      "desktopFetch did not report the synthetic CA as an untrusted authority before installation",
    );
    report.phases.beforeTrust.desktopFetch = { certificateError: beforeTrust.certificateError };
    await checkpoint("Node fetch and desktopFetch reported certificate-authority failures for the untrusted synthetic CA");

    // Mark cleanup as required before invoking certutil because it can import
    // the certificate and still return a failure status.
    certificateStoreTouched = true;
    report.cleanup.certificateRemoved = false;
    await runCapture("certutil.exe", ["-addstore", "Root", certificate.caCertificate], { includeStderr: true, stderrRedactions: [fixtureRoot] });
    assert.equal(await rootCertificateCount(certificate.thumbprint), 1, "Generated CA was not installed exactly once in LocalMachine Root");

    const nodeAfterTrust = await nodeFetchCertificateError(server.localhostUrl);
    assert(nodeAfterTrust.certificateError, "Node fetch did not retain a recognized untrusted-certificate failure after LocalMachine Root changed");
    const trusted = await launchElectronPhase({
      electronPath, bundlePath, fixtureRoot, name: "trusted", url: server.localhostUrl,
    });
    assert.deepEqual(
      trusted,
      {
        ok: true,
        status: 200,
        body: "system trust ok",
        manualRedirect: { status: 302, locationPath: "/ok" },
        manualStream: { status: 200, body: "system trust ok" },
      },
      "desktopFetch did not complete the trusted normal and manual redirect paths",
    );
    assert.deepEqual(
      server.requests.map(request => request.path),
      ["/redirect", "/ok", "/redirect", "/ok", "/ok"],
      "The trusted desktop requests did not perform the expected follow, probe, and stream sequence",
    );
    assert(server.requests.every(request => request.authorized), "desktopFetch did not preserve Authorization on the same-origin redirect");
    report.phases.afterTrust = {
      nodeFetch: {
        certificateError: nodeAfterTrust.certificateError,
        evidence: nodeAfterTrust.evidence,
      },
      desktopFetch: {
        status: 200,
        redirectObserved: true,
        manualRedirectStatus: 302,
        manualStreamStatus: 200,
        authorizationPreserved: true,
      },
    };
    await checkpoint("desktopFetch used LocalMachine Root for normal and manual redirect paths while Node fetch remained untrusted");

    const wrongHost = await launchElectronPhase({
      electronPath, bundlePath, fixtureRoot, name: "wrong-host", url: server.wrongHostUrl,
    });
    assert.deepEqual(
      wrongHost,
      { ok: false, certificateError: "ERR_CERT_COMMON_NAME_INVALID" },
      "desktopFetch did not report the SAN mismatch for 127.0.0.1",
    );
    report.phases.wrongHost = { desktopFetch: { certificateError: wrongHost.certificateError } };
    await checkpoint("desktopFetch reported a common-name failure for the trusted certificate on the wrong host");
  } catch (error) {
    primaryFailure = error;
    report.failure = sanitizedFailure(error, [fixtureRoot]);
  } finally {
    if (packagedRuntimePaths && packagedRuntimeBefore) {
      try {
        assert.deepEqual({
          executable: await fileFingerprint(packagedRuntimePaths.electronPath),
          applicationArchive: await fileFingerprint(packagedRuntimePaths.archivePath),
        }, packagedRuntimeBefore, "Packaged Electron runtime changed during system-trust acceptance");
        report.cleanup.packagedRuntimeUnchanged = true;
      } catch (error) { cleanupFailures.push(error); }
    }
    if (server) {
      try {
        await server.close();
        report.cleanup.serverClosed = true;
      } catch (error) { cleanupFailures.push(error); }
    }
    if (certificate) {
      try {
        const count = await rootCertificateCount(certificate.thumbprint);
        assert(count <= 1, "Generated CA appeared more than once in LocalMachine Root");
        if (certificateStoreTouched && count === 1) {
          await runCapture("certutil.exe", ["-delstore", "Root", certificate.thumbprint], { includeStderr: true, stderrRedactions: [certificate.thumbprint] });
        }
        assert.equal(await rootCertificateCount(certificate.thumbprint), 0, "Generated CA remains in LocalMachine Root after cleanup");
        report.cleanup.certificateRemoved = true;
      } catch (error) { cleanupFailures.push(error); }
    }
    try {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      report.cleanup.temporaryFilesRemoved = true;
    } catch (error) { cleanupFailures.push(error); }

    report.finishedAt = new Date().toISOString();
    report.passed = !primaryFailure && cleanupFailures.length === 0;
    if (cleanupFailures.length > 0) {
      report.cleanup.failure = cleanupFailures.map(error => sanitizedFailure(error, [fixtureRoot]));
    }
    await writeReport(reportPath, report);
  }

  if (primaryFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures].filter(Boolean),
      "Native system trust acceptance failed; see the sanitized JSON report",
    );
  }
  console.log("Native system trust: passed; generated CA and owned fixture files removed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arguments_ = process.argv.slice(2);
  const operation = arguments_[0] === "--native-system-trust-phase"
    ? runElectronPhaseController(arguments_)
    : main(arguments_);
  operation.catch(error => {
    const failure = sanitizedFailure(error);
    console.error(`Native system trust failed: ${failure.name}: ${failure.message}`);
    process.exitCode = 1;
  });
}
