import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { assertProductionUpdateBoundary } from './production-update-boundary.mjs';
const root = process.argv[2] ?? 'bundle';
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.license, 'MIT');
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
assert.equal(Object.keys(manifest.devDependencies ?? {}).length, 0);
const files = (await readdir(root, { recursive: true })).map(path => path.replaceAll('\\', '/'));
assert(!files.some(path => /(^|[/\\])node_modules([/\\]|$)|\.map$/.test(path)));
for (const file of ['dist/main.cjs', 'dist/preload.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) assert(files.includes(file));
const main = await readFile(join(root, 'dist/main.cjs'), 'utf8');
const preload = await readFile(join(root, 'dist/preload.cjs'), 'utf8');
const buildInfoText = await readFile(join(root, 'dist/build-info.json'), 'utf8');
assertProductionUpdateBoundary(manifest, main, preload, buildInfoText);
assert(main.includes('https://pbuchman.github.io/multi-device-context/updates/preview.json'));
assert(main.includes('https://pbuchman.github.io/multi-device-context/updates/preview/'));
const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
for (const dependency of [
  'electron-updater@6.8.9', 'builder-util-runtime@9.7.0', 'fs-extra@10.1.0',
  'js-yaml@4.3.2', 'lazy-val@1.0.5', 'lodash.escaperegexp@4.1.2',
  'lodash.isequal@4.5.0', 'semver@7.7.4', 'tiny-typed-emitter@2.1.0',
]) assert(notices.includes(dependency), `Missing bundled license notice for ${dependency}`);
console.log('PASS isolated desktop package: bundled runtime, MIT and dependency notices; no server packages or source maps');
