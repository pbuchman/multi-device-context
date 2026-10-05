import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCatalog, renderWindowsFeed, writePages, validateCatalog } from './catalog.mjs';

const version = '0.5.5', commit = 'a'.repeat(40), androidVersionCode = 10;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdc-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of [`Multi-Device-Context-${version}-mac-arm64.dmg`, `Multi-Device-Context-${version}-win-x64.exe`, `Multi-Device-Context-${version}-android-v10-release.apk`]) {
    await writeFile(join(directory, name), `synthetic installer ${name}`);
  }
  return { directory, version, commit, androidVersionCode, publishedAt: '2026-10-05T12:00:00.000Z' };
}

test('catalog describes every platform from the exact installer bytes and one release commit', async t => {
  const input = await fixture(t);
  const catalog = await buildCatalog(input);
  assert.equal(catalog.commit, commit);
  assert.equal(catalog.channel, 'preview');
  assert.equal(catalog.artifacts.length, 3);
  for (const artifact of catalog.artifacts) {
    const bytes = Buffer.from(`synthetic installer ${artifact.name}`);
    assert.equal(artifact.size, bytes.length);
    assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(artifact.sha512, createHash('sha512').update(bytes).digest('base64'));
    assert.equal(artifact.url, `https://github.com/pbuchman/multi-device-context/releases/download/v${version}/${artifact.name}`);
  }
  assert.equal(catalog.artifacts.find(a => a.platform === 'android').versionCode, 10);
});

test('a missing platform, invalid revision or unsafe version cannot create a feed', async t => {
  const input = await fixture(t);
  await assert.rejects(buildCatalog({ ...input, version: '../bad' }));
  await assert.rejects(buildCatalog({ ...input, commit: 'main' }));
  await assert.rejects(buildCatalog({ ...input, androidVersionCode: 0 }));
  await rm(join(input.directory, `Multi-Device-Context-${version}-win-x64.exe`));
  await assert.rejects(buildCatalog(input));
});

test('Windows metadata pins the same EXE and digest as the complete Preview catalog', async t => {
  const catalog = await buildCatalog(await fixture(t));
  const artifact = catalog.artifacts.find(a => a.platform === 'win32');
  const feed = renderWindowsFeed(catalog);
  assert.match(feed, /version: 0\.5\.5/);
  assert.ok(feed.includes(artifact.url));
  assert.ok(feed.includes(artifact.sha512));
  assert.ok(feed.includes(String(artifact.size)));
  assert.ok(!feed.includes('.dmg'));
});

test('producer and publisher enforce the same 1 GiB installer limit as clients', async t => {
  const input = await fixture(t);
  const catalog = await buildCatalog(input);
  catalog.artifacts[0].size = 1_073_741_825;
  assert.throws(() => validateCatalog(catalog));
  await truncate(join(input.directory, catalog.artifacts[0].name), 1_073_741_825);
  await assert.rejects(buildCatalog(input));
});

test('publishing rejects a catalog with a different repository or a mismatched release URL', async t => {
  const input = await fixture(t);
  const catalog = await buildCatalog(input);
  const bad = structuredClone(catalog);
  bad.artifacts[0].url = 'https://example.com/install.dmg';
  await assert.rejects(writePages(bad, join(input.directory, 'pages')));
  await assert.rejects(writePages({ ...catalog, releaseUrl: 'https://github.com/another/repo/releases/tag/v0.5.5' }, join(input.directory, 'pages')));
});
