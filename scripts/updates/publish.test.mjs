import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertReleaseReady, downloadPublicAsset } from './publish.mjs';

const commit = 'a'.repeat(40);
const catalog = { version: '0.5.5', commit, artifacts: [{ name: 'app.exe', size: 123 }] };
const release = { tag_name: 'v0.5.5', draft: false, prerelease: true, assets: [{ name: 'app.exe', size: 123 }] };
const runs = ['quality', 'native-installers', 'android'].map((name, index) => ({
  id: index + 1, path: `.github/workflows/${name}.yml`, head_sha: commit,
  head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1,
}));

test('publication requires all three successful main workflows for the actual release commit', () => {
  assert.doesNotThrow(() => assertReleaseReady(catalog, release, commit, runs));
  assert.throws(() => assertReleaseReady(catalog, release, 'b'.repeat(40), runs));
  assert.throws(() => assertReleaseReady(catalog, release, commit, runs.slice(0, 2)));
  assert.throws(() => assertReleaseReady(catalog, release, commit, runs.map(run => ({ ...run, event: 'pull_request' }))));
});

test('a newer failed or active run cannot fall back to an old successful run', () => {
  for (const status of [{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }]) {
    assert.throws(() => assertReleaseReady(catalog, release, commit, [...runs, { ...runs[0], id: 9, ...status }]));
  }
});

test('drafts, stable releases and incomplete assets are not promoted into Preview', () => {
  for (const changes of [{ draft: true }, { prerelease: false }, { tag_name: 'v0.5.4' }, { assets: [] }, { assets: [{ name: 'app.exe', size: 124 }] }]) {
    assert.throws(() => assertReleaseReady(catalog, { ...release, ...changes }, commit, runs));
  }
});

test('anonymous verification follows only trusted redirects and hashes downloaded bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mdc-publisher-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('demo installer');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/demo/installer' } })
      : new Response(payload);
  });
  const path = join(directory, 'installer');
  const result = await downloadPublicAsset('https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/demo', path, payload.length);
  assert.deepEqual(await readFile(path), payload);
  assert.deepEqual(result, { size: payload.length, sha256: createHash('sha256').update(payload).digest('hex'), sha512: createHash('sha512').update(payload).digest('base64') });
  assert.equal(requests.length, 2);
  for (const { options } of requests) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers, undefined);
  }
});

test('verification rejects foreign redirects, redirect loops and oversized bodies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mdc-publisher-rejection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origin = 'https://github.com/pbuchman/multi-device-context/releases/download/v0.5.5/demo';
  let requests = 0;
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/demo' } });
  });
  await assert.rejects(downloadPublicAsset(origin, join(directory, 'foreign'), 10), /Unexpected download host/);
  assert.equal(requests, 1);
  requests = 0;
  mock.mock.mockImplementation(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: origin } });
  });
  await assert.rejects(downloadPublicAsset(origin, join(directory, 'loop'), 10));
  assert.equal(requests, 6);
  mock.mock.mockImplementation(async () => new Response(Buffer.alloc(11)));
  await assert.rejects(downloadPublicAsset(origin, join(directory, 'large'), 10), /exceeds declared size/);
});
