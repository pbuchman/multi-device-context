import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseReady } from './publish.mjs';

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
