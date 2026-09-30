import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder'));
const packager = createRequire(builder.resolve('app-builder-lib'));
const { listPackage, extractFile } = packager('@electron/asar');
const executable = process.env.MDC_NATIVE_EXECUTABLE;
assert(executable, 'Installed executable required');
const archive = process.platform === 'darwin' ? join(dirname(executable), '../Resources/app.asar') : join(dirname(executable), 'resources/app.asar');
const files = listPackage(archive);
assert(!files.some(path => /[/\\]node_modules[/\\]|\.map$/.test(path)), 'Unexpected dependencies or source maps in installed ASAR');
const manifest = JSON.parse(extractFile(archive, 'package.json').toString());
assert.equal(manifest.license, 'MIT'); assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
for (const name of ['dist/main.cjs', 'dist/preload.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) assert(extractFile(archive, name).length);
for (const name of ['dist/main.cjs', 'dist/preload.cjs']) {
  const text = extractFile(archive, name).toString();
  assert(!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|sk-or-v1-[a-f0-9]{32,}|ghp_[A-Za-z0-9]{30,}|mdc_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}/.test(text), 'Credential pattern in installed code');
}
console.log(JSON.stringify({ check: 'installed-package-boundary', status: 'PASS', files: files.length, version: manifest.version }));
