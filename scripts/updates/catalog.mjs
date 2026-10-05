import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/pbuchman/multi-device-context';
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
function identity(version, commit, androidVersionCode) {
  assert.equal(typeof version, 'string');
  assert.match(version, versionPattern, 'A numeric release version is required');
  assert.match(commit, /^[a-f0-9]{40}$/, 'A full source commit is required');
  assert(Number.isSafeInteger(androidVersionCode) && androidVersionCode > 0 && androidVersionCode <= 2100000000, 'Invalid Android version code');
}
function definitions(version, code) {
  return [
    { platform: 'darwin', arch: 'arm64', format: 'dmg', name: `Multi-Device-Context-${version}-mac-arm64.dmg`, minimumSystemVersion: '13.0.0' },
    { platform: 'win32', arch: 'x64', format: 'exe', name: `Multi-Device-Context-${version}-win-x64.exe`, minimumSystemVersion: '10.0.0' },
    { platform: 'android', arch: 'universal', format: 'apk', name: `Multi-Device-Context-${version}-android-v${code}-release.apk`, versionCode: code, minimumSdk: 26 },
  ];
}
async function digests(path) {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512');
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk); }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

/** Generate metadata only after every selected platform artifact exists. */
export async function buildCatalog({ directory, version, commit, androidVersionCode, publishedAt = new Date().toISOString() }) {
  identity(version, commit, androidVersionCode);
  assert.equal(new Date(publishedAt).toISOString(), publishedAt, 'Use an ISO publication time');
  const artifacts = [];
  for (const definition of definitions(version, androidVersionCode)) {
    const path = join(directory, definition.name);
    const stat = await lstat(path);
    assert(stat.isFile() && stat.size > 0, `Missing ordinary installer: ${definition.name}`);
    artifacts.push({ ...definition, url: `${repository}/releases/download/v${version}/${definition.name}`, size: stat.size, ...await digests(path) });
  }
  return { schemaVersion: 1, channel: 'preview', version, commit, publishedAt, releaseUrl: `${repository}/releases/tag/v${version}`, artifacts };
}

export function validateCatalog(catalog) {
  assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog));
  assert.deepEqual(Object.keys(catalog).sort(), ['schemaVersion', 'channel', 'version', 'commit', 'publishedAt', 'releaseUrl', 'artifacts'].sort());
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.channel, 'preview');
  assert(Array.isArray(catalog.artifacts) && catalog.artifacts.length === 3);
  const android = catalog.artifacts.find(asset => asset.platform === 'android');
  identity(catalog.version, catalog.commit, android?.versionCode);
  assert.equal(new Date(catalog.publishedAt).toISOString(), catalog.publishedAt);
  assert.equal(catalog.releaseUrl, `${repository}/releases/tag/v${catalog.version}`);
  for (const expected of definitions(catalog.version, android.versionCode)) {
    const matches = catalog.artifacts.filter(asset => asset.platform === expected.platform);
    assert.equal(matches.length, 1);
    const asset = matches[0];
    assert.deepEqual(Object.keys(asset).sort(), [...Object.keys(expected), 'url', 'size', 'sha256', 'sha512'].sort());
    for (const [key, value] of Object.entries(expected)) assert.equal(asset[key], value);
    assert.equal(asset.url, `${repository}/releases/download/v${catalog.version}/${expected.name}`);
    assert(Number.isSafeInteger(asset.size) && asset.size > 0);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.match(asset.sha512, /^[A-Za-z0-9+/]{86}==$/);
  }
  return catalog;
}

export function renderWindowsFeed(catalog) {
  validateCatalog(catalog);
  const asset = catalog.artifacts.find(value => value.platform === 'win32');
  return `version: ${catalog.version}\nfiles:\n  - url: ${asset.url}\n    sha512: ${asset.sha512}\n    size: ${asset.size}\npath: ${asset.url}\nsha512: ${asset.sha512}\nreleaseDate: ${catalog.publishedAt}\n`;
}

/** Write a complete Pages deployment; no partially uploaded release is advertised. */
export async function writePages(catalog, directory) {
  validateCatalog(catalog);
  const updates = join(directory, 'updates');
  await mkdir(join(updates, 'preview'), { recursive: true });
  await writeFile(join(directory, '.nojekyll'), '');
  await writeFile(join(updates, 'preview.json'), JSON.stringify(catalog, null, 2) + '\n');
  await writeFile(join(updates, 'preview/latest.yml'), renderWindowsFeed(catalog));
  await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Multi Device Context updates</title><h1>Multi Device Context updates</h1><p>Preview update metadata. <a href="https://github.com/pbuchman/multi-device-context/releases">Download installers</a>.</p>\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, version, commit, code] = process.argv.slice(2);
  assert(directory && version && commit && code, 'Usage: catalog.mjs ARTIFACT_DIRECTORY VERSION COMMIT ANDROID_VERSION_CODE');
  const catalog = await buildCatalog({ directory, version, commit, androidVersionCode: Number(code) });
  await writeFile(join(directory, 'update-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Validated complete Preview catalog for ${version} (${commit})`);
}
