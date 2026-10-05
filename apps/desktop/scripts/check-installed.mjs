import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder'));
const packager = createRequire(builder.resolve('app-builder-lib'));
const { listPackage, extractFile } = packager('@electron/asar');
const executable = process.env.MDC_NATIVE_EXECUTABLE;
assert(executable, 'Installed executable required');
const targetPlatform = process.env.MDC_NATIVE_PLATFORM ?? process.platform;
assert(['darwin', 'win32'].includes(targetPlatform), 'Installed package platform must be darwin or win32');
const archive = targetPlatform === 'darwin' ? join(dirname(executable), '../Resources/app.asar') : join(dirname(executable), 'resources/app.asar');
const resources = targetPlatform === 'darwin' ? join(dirname(executable), '../Resources') : join(dirname(executable), 'resources');
const files = listPackage(archive);
assert(!files.some(path => /[/\\]node_modules[/\\]|\.map$/.test(path)), 'Unexpected dependencies or source maps in installed ASAR');
const manifest = JSON.parse(extractFile(archive, 'package.json').toString());
assert.equal(manifest.license, 'MIT'); assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
for (const name of ['dist/main.cjs', 'dist/preload.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) assert(extractFile(archive, name).length);
for (const name of ['dist/main.cjs', 'dist/preload.cjs']) {
  const text = extractFile(archive, name).toString();
  assert(!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|sk-or-v1-[a-f0-9]{32,}|ghp_[A-Za-z0-9]{30,}|mdc_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}/.test(text), 'Credential pattern in installed code');
}
const installedMain = extractFile(archive, 'dist/main.cjs').toString();
assert(installedMain.includes('autoInstallOnAppQuit = false'), 'Bundled NSIS ordinary-quit guard missing');
assert(installedMain.includes('https://pbuchman.github.io/multi-device-context/updates/preview.json'));
assert(installedMain.includes('https://pbuchman.github.io/multi-device-context/updates/preview/'));
const updateConfiguration = await readFile(join(resources, 'app-update.yml'), 'utf8');
assert.match(updateConfiguration, /^provider: generic$/m);
assert.match(updateConfiguration, /^url: https:\/\/pbuchman\.github\.io\/multi-device-context\/updates\/preview\/$/m);
assert.match(updateConfiguration, /^updaterCacheDirName: /m);
assert(!/token|authorization|password/i.test(updateConfiguration), 'Unexpected update feed credentials');
assert(!/^publisherName:/m.test(updateConfiguration), 'Unsigned build must not claim an updater publisher identity');
if (targetPlatform === 'win32') {
  const elevate = await readFile(join(resources, 'elevate.exe'));
  assert(elevate.length > 0, 'Missing NSIS updater elevation helper');
}
console.log(JSON.stringify({ check: 'installed-package-boundary', status: 'PASS', files: files.length, version: manifest.version }));
