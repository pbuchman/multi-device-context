import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { validateCatalog, writePages } from './catalog.mjs';

const repo = 'pbuchman/multi-device-context';
const required = ['quality', 'native-installers', 'android'].map(name => `.github/workflows/${name}.yml`);
export function assertReleaseReady(catalog, release, tagCommit, runs) {
  assert.equal(release.tag_name, `v${catalog.version}`, 'Release version mismatch');
  assert.equal(release.draft, false, 'Publish the completed release before promoting its feed');
  assert.equal(release.prerelease, true, 'Preview accepts only prereleases');
  assert.equal(tagCommit, catalog.commit, 'Release tag does not identify the catalog commit');
  for (const asset of catalog.artifacts) {
    const matches = release.assets.filter(value => value.name === asset.name);
    assert.equal(matches.length, 1, `Missing or ambiguous asset: ${asset.name}`);
    assert.equal(matches[0].size, asset.size, `Asset size mismatch: ${asset.name}`);
  }
  for (const path of required) {
    const latest = runs.filter(run => run.path === path && run.head_sha === catalog.commit && run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event))
      .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
    assert(latest && latest.status === 'completed' && latest.conclusion === 'success', `Latest main check must succeed: ${path}`);
  }
}

function api(path, paginate = false) {
  return JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), `repos/${repo}/${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
}

/** No Authorization header is sent to public release assets or CDN redirects. */
export async function downloadPublicAsset(url, destination, maximumBytes) {
  let response;
  for (let hop = 0; hop <= 5; hop++) {
    const current = new URL(url);
    assert(current.protocol === 'https:' && !current.username && !current.password && !current.hash);
    assert(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(current.hostname), 'Unexpected download host');
    response = await fetch(current, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(180000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      assert(location, 'Missing download redirect');
      url = new URL(location, current).href;
      response = undefined;
      continue;
    }
    break;
  }
  assert(response?.ok && response.body, 'Anonymous release download failed');
  let size = 0;
  const sha256 = createHash('sha256'), sha512 = createHash('sha512');
  const inspect = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > maximumBytes) { callback(new Error('Release asset exceeds declared size')); return; }
    sha256.update(chunk); sha512.update(chunk); callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), inspect, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

export async function preparePublishedFeed(tag, output) {
  assert.match(tag, /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
  const temporary = await mkdtemp(join(tmpdir(), 'mdc-published-release-'));
  try {
    const catalogPath = join(temporary, 'catalog.json');
    await downloadPublicAsset(`https://github.com/${repo}/releases/download/${tag}/update-catalog.json`, catalogPath, 64 * 1024);
    const catalog = validateCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
    assert.equal(tag, `v${catalog.version}`);
    const release = api(`releases/tags/${tag}`);
    const tagCommit = api(`commits/${tag}`).sha;
    const comparison = api(`compare/${catalog.commit}...main`);
    assert(['ahead', 'identical'].includes(comparison.status), 'Release commit is not on main');
    const runs = api(`actions/runs?head_sha=${catalog.commit}&per_page=100`, true).flatMap(page => page.workflow_runs);
    assertReleaseReady(catalog, release, tagCommit, runs);
    for (const artifact of catalog.artifacts) {
      const actual = await downloadPublicAsset(artifact.url, join(temporary, artifact.name), artifact.size);
      assert.deepEqual(actual, { size: artifact.size, sha256: artifact.sha256, sha512: artifact.sha512 }, `Installer verification failed: ${artifact.name}`);
    }
    await writePages(catalog, output);
    console.log(`Verified anonymous downloads and main checks for ${tag} (${catalog.commit})`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 4, 'Usage: publish.mjs TAG OUTPUT_DIRECTORY');
  await preparePublishedFeed(process.argv[2], process.argv[3]);
}
