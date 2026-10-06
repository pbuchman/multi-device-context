// This changes CurrentUser\\Root only on an ephemeral Windows GitHub runner.
// The generated CA is unique to this run, asserted absent first, and removed by
// exact thumbprint in finally. No production certificate or TLS override is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
  assert(Number.isSafeInteger(count) && count >= 0, "Could not count the generated CA in CurrentUser Root");
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

export function childEntrySource() {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "native-system-trust-helpers.mjs");
  return `
process.stderr.write("MDC native system trust child: bootstrap\\n");
const { app } = require("electron");
const { writeFileSync } = require("node:fs");
const { desktopFetch } = require("./src/network.ts");
const { classifyChromiumCertificateError } = require(${JSON.stringify(helperPath)});

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(\`Missing \${name}\`);
  return process.argv[index + 1];
}

const url = argument("--native-system-trust-url");
const userDataPath = argument("--native-system-trust-user-data");
const resultPath = argument("--native-system-trust-result");
app.setPath("userData", userDataPath);
(async () => {
  let result;
  try {
    await app.whenReady();
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
  } finally {
    writeFileSync(resultPath, JSON.stringify(result));
    app.exit(0);
  }
})();
`;
}

export async function compileElectronChild(desktopDirectory, outputPath) {
  const networkPath = join(desktopDirectory, "src/network.ts");
  await readFile(networkPath);
  await withDeadline(build({
    stdin: {
      contents: childEntrySource(),
      resolveDir: desktopDirectory,
      sourcefile: "native-system-trust-child.cjs",
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

export async function prepareElectronChild(desktopDirectory, applicationDirectory) {
  await mkdir(applicationDirectory, { recursive: true });
  await writeFile(join(applicationDirectory, "package.json"), JSON.stringify({
    name: "mdc-native-system-trust-child",
    version: "1.0.0",
    private: true,
    main: "main.cjs",
    type: "commonjs",
  }, null, 2) + "\n");
  const bundlePath = join(applicationDirectory, "main.cjs");
  await compileElectronChild(desktopDirectory, bundlePath);
  return bundlePath;
}

async function launchElectronPhase({ electronPath, applicationDirectory, fixtureRoot, name, url }) {
  const userData = join(fixtureRoot, `user-data-${name}`);
  const resultPath = join(fixtureRoot, `result-${name}.json`);
  await mkdir(userData, { recursive: true });
  const electronEnvironment = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete electronEnvironment.ELECTRON_RUN_AS_NODE;
  delete electronEnvironment.NODE_OPTIONS;
  await runCapture(electronPath, [
    "--enable-logging=stderr",
    applicationDirectory,
    "--native-system-trust-url", url,
    "--native-system-trust-user-data", userData,
    "--native-system-trust-result", resultPath,
  ], {
    deadlineMs: ELECTRON_DEADLINE_MS,
    cwd: applicationDirectory,
    env: electronEnvironment,
    includeStderr: true,
    stderrRedactions: [fixtureRoot, AUTHORIZATION],
  });
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(typeof result.ok, "boolean", `Electron ${name} phase did not return a result`);
  return result;
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
      serverClosed: false,
      temporaryFilesRemoved: false,
    },
  };
  let certificate;
  let certificateStoreTouched = false;
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
    const electronPath = require("electron");
    assert.equal(typeof electronPath, "string", "Could not resolve the Electron executable");

    const openSsl = await findOpenSsl();
    certificate = await generateCertificates(openSsl, fixtureRoot);
    assert.equal(await rootCertificateCount(certificate.thumbprint), 0, "Generated CA already exists in CurrentUser Root");
    report.cleanup.certificateAbsentInitially = true;
    await checkpoint("Generated a unique localhost CA and confirmed it was absent from CurrentUser Root");

    server = await startHttpsFixture(certificate.serverCertificate, certificate.serverKey);
    const applicationDirectory = join(fixtureRoot, "electron-child");
    await prepareElectronChild(desktopDirectory, applicationDirectory);
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
      electronPath, applicationDirectory, fixtureRoot, name: "before-trust", url: server.localhostUrl,
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
    await runCapture("certutil.exe", ["-user", "-addstore", "Root", certificate.caCertificate]);
    assert.equal(await rootCertificateCount(certificate.thumbprint), 1, "Generated CA was not installed exactly once in CurrentUser Root");

    const nodeAfterTrust = await nodeFetchCertificateError(server.localhostUrl);
    assert(nodeAfterTrust.certificateError, "Node fetch did not retain a recognized untrusted-certificate failure after CurrentUser Root changed");
    const trusted = await launchElectronPhase({
      electronPath, applicationDirectory, fixtureRoot, name: "trusted", url: server.localhostUrl,
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
    await checkpoint("desktopFetch used CurrentUser Root for normal and manual redirect paths while Node fetch remained untrusted");

    const wrongHost = await launchElectronPhase({
      electronPath, applicationDirectory, fixtureRoot, name: "wrong-host", url: server.wrongHostUrl,
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
    if (server) {
      try {
        await server.close();
        report.cleanup.serverClosed = true;
      } catch (error) { cleanupFailures.push(error); }
    }
    if (certificate) {
      try {
        const count = await rootCertificateCount(certificate.thumbprint);
        assert(count <= 1, "Generated CA appeared more than once in CurrentUser Root");
        if (certificateStoreTouched && count === 1) {
          await runCapture("certutil.exe", ["-user", "-delstore", "Root", certificate.thumbprint]);
        }
        assert.equal(await rootCertificateCount(certificate.thumbprint), 0, "Generated CA remains in CurrentUser Root after cleanup");
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
  main().catch(error => {
    const failure = sanitizedFailure(error);
    console.error(`Native system trust failed: ${failure.name}: ${failure.message}`);
    process.exitCode = 1;
  });
}
