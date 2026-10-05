import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ACCEPTANCE_PORT = 38443;
const PACKAGE = 'com.multidevicecontext.mobile';
const ACTION = `${PACKAGE}.ACCEPTANCE_UPDATE`;
const VERSION_A = '90.0.1';
const VERSION_B = '90.0.2';
const CODE_A = 10001;
const CODE_B = 10002;
const FIXED_ORIGIN = `https://127.0.0.1:${ACCEPTANCE_PORT}`;
const FIXTURE_APP_ORIGIN = 'https://context.example.com';
const NO_SIGNING = '/tmp/mdc-android-acceptance-no-signing.json';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(SCRIPT_DIR, '../../..');
const ANDROID = join(REPOSITORY, 'apps/mobile/android');
const APK = join(ANDROID, 'app/build/outputs/apk/acceptance/app-acceptance.apk');
const CA_RESOURCE = join(ANDROID, 'app/src/acceptance/res/raw/mdc_acceptance_ca.pem');
const DEFAULT_REPORT = join(ANDROID, 'build/reports/android-update-acceptance.json');

export function acceptanceEnvironment(repository, source, versionName, versionCode) {
  const env = { ...source };
  for (const key of ['MDC_ANDROID_KEYSTORE', 'MDC_ANDROID_KEY_ALIAS', 'MDC_ANDROID_STORE_PASSWORD', 'MDC_ANDROID_KEY_PASSWORD']) delete env[key];
  return {
    ...env,
    CI: 'true',
    MDC_APP_ORIGIN: FIXTURE_APP_ORIGIN,
    MDC_MOBILE_CONFIG_FIXTURE: join(repository, 'apps/mobile/tests/fixtures/runtime-config.json'),
    MDC_ANDROID_SIGNING_CONFIG: NO_SIGNING,
    MDC_ANDROID_ACCEPTANCE_VERSION_NAME: versionName,
    MDC_ANDROID_ACCEPTANCE_VERSION_CODE: String(versionCode),
  };
}

export function catalogForArtifact(artifact) {
  const common = (platform, arch, format, suffix, minimum) => {
    const name = `Multi-Device-Context-${VERSION_B}-${suffix}`;
    return { platform, arch, format, name, url: `${FIXED_ORIGIN}/repository/releases/download/v${VERSION_B}/${name}`, size: artifact.size, sha256: artifact.sha256, sha512: artifact.sha512, ...minimum };
  };
  return {
    schemaVersion: 1,
    channel: 'preview',
    version: VERSION_B,
    commit: 'a'.repeat(40),
    publishedAt: '2026-10-06T00:00:00.000Z',
    releaseUrl: `${FIXED_ORIGIN}/repository/releases/tag/v${VERSION_B}`,
    artifacts: [
      common('darwin', 'arm64', 'dmg', 'mac-arm64.dmg', { minimumSystemVersion: '13.0.0' }),
      common('win32', 'x64', 'exe', 'win-x64.exe', { minimumSystemVersion: '10.0.0' }),
      common('android', 'universal', 'apk', `android-v${CODE_B}-release.apk`, { versionCode: CODE_B, minimumSdk: 26 }),
    ],
  };
}

export function uiTarget(xml, candidates) {
  const expected = candidates.map(candidate => candidate.toLowerCase());
  let labelFallback;
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    const attributes = Object.fromEntries([...node.matchAll(/([\w:-]+)="([^"]*)"/g)].map(value => [value[1], value[2]]));
    const resourceId = (attributes['resource-id'] ?? '').toLowerCase();
    const labels = [(attributes.text ?? '').toLowerCase(), (attributes['content-desc'] ?? '').toLowerCase()];
    const matchesResource = expected.some(candidate => resourceId === candidate || resourceId.endsWith(`/${candidate}`));
    const matchesLabel = expected.some(candidate => labels.includes(candidate));
    if (!matchesResource && !matchesLabel) continue;
    const bounds = /^\[(\d+),(\d+)]\[(\d+),(\d+)]$/.exec(attributes.bounds ?? '');
    if (!bounds) continue;
    const target = { x: Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2), y: Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2) };
    if (matchesResource || attributes.clickable === 'true') return target;
    labelFallback ??= target;
  }
  return labelFallback;
}

async function command(program, args, options = {}) {
  const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (options.echo) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { stderr += chunk; if (options.echo) process.stderr.write(chunk); });
  const result = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal, stdout, stderr })); });
  if (result.code !== 0 && !options.allowFailure) throw new Error(`${program} ${args.join(' ')} failed (${result.code ?? result.signal}): ${stderr || stdout}`);
  return result;
}

export async function prepareMobile(repository, environment, runCommand = command) {
  const mobile = join(repository, 'apps/mobile');
  await runCommand(process.execPath, ['--experimental-strip-types', 'scripts/build.mjs'], { cwd: mobile, env: environment, echo: true });
  await runCommand('pnpm', ['exec', 'cap', 'sync', 'android'], { cwd: mobile, env: environment, echo: true });
}

export function registerInterruptCleanup(target, caResource = CA_RESOURCE) {
  const handlers = new Map();
  const dispose = () => {
    for (const [signal, handler] of handlers) target.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      try { rmSync(caResource, { force: true }); }
      finally {
        dispose();
        target.kill(target.pid, signal);
      }
    };
    handlers.set(signal, handler);
    target.once(signal, handler);
  }
  return dispose;
}

async function waitFor(operation, description, timeout = 30_000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await operation(); if (value !== undefined && value !== false) return value; } catch (cause) { last = cause; }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${description}${last ? `: ${last.message}` : ''}`);
}

function digest(algorithm, bytes, encoding) { return createHash(algorithm).update(bytes).digest(encoding); }

async function main() {
  const reportPath = process.env.MDC_ANDROID_ACCEPTANCE_REPORT || DEFAULT_REPORT;
  const report = { success: false, startedAt: new Date().toISOString(), emulator: process.env.ANDROID_SERIAL, stages: [], limits: ['Synthetic generic-debug-key emulator acceptance; no physical/private-signed device evidence.'] };
  let server; let adb; let temporary;
  const disposeInterruptCleanup = registerInterruptCleanup(process);
  const stage = (name, evidence = {}) => { report.stages.push({ name, at: new Date().toISOString(), ...evidence }); };
  try {
    assert.equal(process.env.CI, 'true', 'CI=true is required');
    assert.match(process.env.ANDROID_SERIAL ?? '', /^emulator-\d+$/, 'An explicit Android emulator serial is required');
    assert.ok(process.env.JAVA_HOME, 'JAVA_HOME is required');
    assert.ok(process.env.ANDROID_HOME, 'ANDROID_HOME is required');
    await assert.rejects(stat(NO_SIGNING), undefined, `${NO_SIGNING} must not exist`);
    adb = join(process.env.ANDROID_HOME, 'platform-tools/adb');
    assert.equal((await command(adb, ['-s', process.env.ANDROID_SERIAL, 'get-state'])).stdout.trim(), 'device');
    assert.equal((await command(adb, ['-s', process.env.ANDROID_SERIAL, 'shell', 'getprop', 'ro.kernel.qemu'])).stdout.trim(), '1', 'Acceptance must run on an emulator');
    assert.equal((await command(adb, ['-s', process.env.ANDROID_SERIAL, 'shell', 'getprop', 'ro.build.version.sdk'])).stdout.trim(), '36', 'Acceptance requires API 36');
    stage('api36-emulator-preflight');
    temporary = await mkdtemp(join(tmpdir(), 'mdc-android-update-acceptance-'));
    const key = join(temporary, 'server-key.pem'); const certificate = join(temporary, 'server-certificate.pem');
    await mkdir(dirname(CA_RESOURCE), { recursive: true });
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', certificate, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
    await copyFile(certificate, CA_RESOURCE);
    stage('ephemeral-test-ca', { certificate, privateKeyUsedForAppSigning: false });

    const baseEnvironment = { ...process.env, ANDROID_SERIAL: process.env.ANDROID_SERIAL };
    await prepareMobile(REPOSITORY, acceptanceEnvironment(REPOSITORY, baseEnvironment, VERSION_A, CODE_A));
    stage('prepared-fixture-web-and-capacitor');
    const build = async (version, code) => {
      const env = acceptanceEnvironment(REPOSITORY, baseEnvironment, version, code);
      await command('./gradlew', [':app:clean', ':app:assembleAcceptance'], { cwd: ANDROID, env, echo: true });
      return readFile(APK);
    };
    const bBytes = await build(VERSION_B, CODE_B);
    const bPath = join(temporary, 'exact-b.apk'); await writeFile(bPath, bBytes);
    const artifact = { size: bBytes.length, sha256: digest('sha256', bBytes, 'hex'), sha512: digest('sha512', bBytes, 'base64') };
    const catalog = Buffer.from(`${JSON.stringify(catalogForArtifact(artifact))}\n`);
    const aBytes = await build(VERSION_A, CODE_A);
    const aPath = join(temporary, 'a.apk'); await writeFile(aPath, aBytes);
    assert.equal(digest('sha256', await readFile(bPath), 'hex'), artifact.sha256, 'preserved B bytes changed after building A');
    stage('built-a-and-preserved-exact-b', { a: { version: VERSION_A, code: CODE_A, sha256: digest('sha256', aBytes, 'hex') }, b: { version: VERSION_B, code: CODE_B, path: bPath, ...artifact } });

    const requests = { catalog: 0, artifact: 0 };
    server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
      if (request.url === '/updates/preview.json') { requests.catalog++; response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': catalog.length }); response.end(catalog); return; }
      const expected = `/repository/releases/download/v${VERSION_B}/Multi-Device-Context-${VERSION_B}-android-v${CODE_B}-release.apk`;
      if (request.url === expected) { requests.artifact++; response.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': bBytes.length }); response.end(bBytes); return; }
      response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('not found');
    });
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(ACCEPTANCE_PORT, '127.0.0.1', resolveListen); });
    await command(adb, ['-s', process.env.ANDROID_SERIAL, 'reverse', `tcp:${ACCEPTANCE_PORT}`, `tcp:${ACCEPTANCE_PORT}`]);
    await command(adb, ['-s', process.env.ANDROID_SERIAL, 'uninstall', PACKAGE], { allowFailure: true });
    await command(adb, ['-s', process.env.ANDROID_SERIAL, 'shell', 'am', 'force-stop', 'com.google.android.packageinstaller']);
    await command(adb, ['-s', process.env.ANDROID_SERIAL, 'install', aPath]);
    stage('installed-a-bootstrap', { via: 'adb install (bootstrap only)' });

    const adbCommand = (args, options) => command(adb, ['-s', process.env.ANDROID_SERIAL, ...args], options);
    const dumpsys = async () => (await adbCommand(['shell', 'dumpsys', 'package', PACKAGE])).stdout;
    let packageDump = await dumpsys();
    assert.match(packageDump, new RegExp(`versionCode=${CODE_A}\\b`)); assert.match(packageDump, new RegExp(`versionName=${VERSION_A.replaceAll('.', '\\.')}\\b`));

    const sentinels = {
      'files/android-update-acceptance/preserved/draft.json': '{"draft":"unsent acceptance text"}',
      'files/inbox/preserved-share.json': '{"share":"pending"}',
      'files/android-update-acceptance/preserved/settings.json': '{"theme":"dark","setting":true}',
    };
    await adbCommand(['shell', 'run-as', PACKAGE, 'mkdir', '-p', 'files/android-update-acceptance/preserved', 'files/inbox']);
    for (const [path, value] of Object.entries(sentinels)) await adbCommand(['shell', 'run-as', PACKAGE, 'tee', path], { input: value });
    stage('seeded-private-data', { paths: Object.keys(sentinels) });

    const manager = async operation => {
      const token = randomUUID().replaceAll('-', ''); const path = `files/android-update-acceptance/${token}.json`;
      await adbCommand(['shell', 'am', 'broadcast', '-a', ACTION, '-n', `${PACKAGE}/.AcceptanceUpdateReceiver`, '--es', 'operation', operation, '--es', 'token', token]);
      const response = await waitFor(async () => {
        const result = await adbCommand(['exec-out', 'run-as', PACKAGE, 'cat', path], { allowFailure: true });
        if (result.code !== 0 || !result.stdout.trim()) return undefined;
        const value = JSON.parse(result.stdout); return value.token === token ? value : undefined;
      }, `manager ${operation}`, operation === 'download' ? 120_000 : 30_000);
      assert.equal(response.ok, true, `${operation}: ${response.error ?? 'failed'}`); return response.state;
    };
    let state = await manager('check'); assert.equal(state.status, 'available'); assert.equal(state.availableVersion, VERSION_B); assert.equal(state.progress.total, artifact.size);
    state = await manager('download'); assert.equal(state.status, 'ready'); assert.equal(state.progress.transferred, artifact.size);
    assert.equal(requests.catalog, 1); assert.equal(requests.artifact, 1);
    stage('manager-catalog-download-verified', { state, requests: { ...requests } });

    const hierarchy = async () => {
      await adbCommand(['shell', 'uiautomator', 'dump', '/sdcard/mdc-acceptance-window.xml'], { allowFailure: true });
      return (await adbCommand(['exec-out', 'cat', '/sdcard/mdc-acceptance-window.xml'])).stdout;
    };
    const foregroundApp = async () => {
      await adbCommand(['shell', 'am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`]);
      await waitFor(async () => {
        const activities = (await adbCommand(['shell', 'dumpsys', 'activity', 'activities'])).stdout;
        return /topResumedActivity=.*com\.multidevicecontext\.mobile\/.MainActivity/.test(activities) ? true : undefined;
      }, 'visible app activity before PackageInstaller commit');
    };
    const openUnknownSources = async () => {
      await adbCommand(['shell', 'am', 'start', '-a', 'android.settings.MANAGE_UNKNOWN_APP_SOURCES', '-d', `package:${PACKAGE}`]);
      return waitFor(async () => {
        const xml = await hierarchy(); return uiTarget(xml, ['switch_widget', 'allow from this source']) ? xml : undefined;
      }, 'Install unknown apps screen');
    };
    await openUnknownSources(); await adbCommand(['shell', 'input', 'keyevent', 'BACK']);
    state = await manager('permissionDenied'); assert.equal(state.status, 'ready'); assert.match(state.message, /not granted/i);
    stage('unknown-source-refused', { state });

    let xml = await openUnknownSources(); const permissionSwitch = uiTarget(xml, ['switch_widget', 'allow from this source']); assert.ok(permissionSwitch);
    await adbCommand(['shell', 'input', 'tap', String(permissionSwitch.x), String(permissionSwitch.y)]); await adbCommand(['shell', 'input', 'keyevent', 'BACK']);
    stage('unknown-source-granted-through-system-ui');

    const installerTarget = async kind => waitFor(async () => {
      const current = await hierarchy();
      const candidates = kind === 'cancel' ? ['cancel_button', 'android:id/button2', 'cancel'] : ['install_button', 'android:id/button1', 'update', 'install'];
      const target = uiTarget(current, candidates); return target ? { target, xml: current } : undefined;
    }, `system installer ${kind} button`, 30_000);

    await foregroundApp(); state = await manager('install'); assert.equal(state.status, 'installing');
    let button = await installerTarget('cancel'); await adbCommand(['shell', 'input', 'tap', String(button.target.x), String(button.target.y)]);
    state = await waitFor(async () => { const current = await manager('state'); return current.status === 'error' ? current : undefined; }, 'installer cancellation callback');
    assert.match(state.message, /cancel/i); packageDump = await dumpsys(); assert.match(packageDump, new RegExp(`versionCode=${CODE_A}\\b`));
    stage('system-confirmation-cancelled', { state });

    state = await manager('check'); assert.equal(state.status, 'available'); state = await manager('download'); assert.equal(state.status, 'ready');
    assert.equal(requests.catalog, 2); assert.equal(requests.artifact, 2); assert.equal(digest('sha256', await readFile(bPath), 'hex'), artifact.sha256);
    await foregroundApp(); state = await manager('install'); assert.equal(state.status, 'installing');
    button = await installerTarget('install'); await adbCommand(['shell', 'input', 'tap', String(button.target.x), String(button.target.y)]);
    packageDump = await waitFor(async () => { const current = await dumpsys(); return new RegExp(`versionCode=${CODE_B}\\b`).test(current) ? current : undefined; }, 'version B installation', 60_000);
    assert.match(packageDump, new RegExp(`versionName=${VERSION_B.replaceAll('.', '\\.')}\\b`));
    const installedPathOutput = (await adbCommand(['shell', 'pm', 'path', PACKAGE])).stdout.trim();
    const installedPath = installedPathOutput.split('\n').map(line => line.replace(/^package:/, '')).find(line => line.endsWith('/base.apk'));
    assert.ok(installedPath, `No installed base APK in ${installedPathOutput}`);
    const installedHash = (await adbCommand(['shell', 'sha256sum', installedPath])).stdout.trim().split(/\s+/)[0];
    assert.equal(installedHash, artifact.sha256, 'installed base APK differs from preserved synthetic B');
    for (const [path, expected] of Object.entries(sentinels)) assert.equal((await adbCommand(['exec-out', 'run-as', PACKAGE, 'cat', path])).stdout, expected, `${path} changed`);
    await waitFor(async () => {
      const updatePrefs = await adbCommand(['exec-out', 'run-as', PACKAGE, 'cat', 'shared_prefs/mdc-updates.xml'], { allowFailure: true });
      return !/installerSession|installerToken|installerVersion/.test(updatePrefs.stdout) ? updatePrefs.stdout : undefined;
    }, 'successful installer callback identity cleanup');
    stage('manager-packageinstaller-a-to-b-success', { installed: { version: VERSION_B, code: CODE_B, path: installedPath, sha256: installedHash }, requests: { ...requests }, privateDataPreserved: Object.keys(sentinels), callbackIdentityCleared: true });

    report.success = true; report.completedAt = new Date().toISOString(); report.artifact = artifact;
  } catch (cause) {
    report.error = cause instanceof Error ? { message: cause.message, stack: cause.stack } : { message: String(cause) };
    throw cause;
  } finally {
    disposeInterruptCleanup();
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    if (adb && process.env.ANDROID_SERIAL) await command(adb, ['-s', process.env.ANDROID_SERIAL, 'reverse', '--remove', `tcp:${ACCEPTANCE_PORT}`], { allowFailure: true });
    await rm(CA_RESOURCE, { force: true });
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Android update acceptance report: ${reportPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(cause => { console.error(cause); process.exitCode = 1; });
