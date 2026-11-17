import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../skills/multi-device-context/scripts/mdc.mjs', import.meta.url));
const contextId = '20000000-0000-4000-8000-000000000001';
const itemId = '30000000-0000-4000-8000-000000000001';
const otherItemId = '30000000-0000-4000-8000-000000000002';
const payload = Buffer.alloc(64 * 1024, 0xa5);
const contentPath = id => `/api/agent/v1/contexts/${contextId}/items/${id}/content`;

async function fixture(t, handleRequest, linkError) {
  const dir = await mkdtemp(join(tmpdir(), 'mdc-cli-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  const preload = join(dir, 'fetch.mjs');
  const outputDir = join(dir, 'downloads');
  const outputPath = join(outputDir, 'document.bin');
  await mkdir(outputDir);
  await writeFile(config, JSON.stringify({ url: 'https://synthetic.invalid', key: 'mdc_synthetic_test_key' }), { mode: 0o600 });
  const server = createServer(handleRequest);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, init) => fetch('http://127.0.0.1:${server.address().port}' + new URL(url).pathname, init);
    const linkError = ${JSON.stringify(linkError)};
    if (linkError) {
      fs.link = async () => { throw Object.assign(new Error('Injected link failure'), { code: linkError }); };
      syncBuiltinESMExports();
    }
  `);
  async function download(id = itemId) {
    const child = spawn(process.execPath, ['--import', preload, cli, 'download', contextId, id, outputPath], {
      env: { ...process.env, MDC_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }
  return { download, outputDir, outputPath };
}

function writeHeaders(res, buffer) {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buffer.length });
}

function servePayload(req, res) {
  if (req.url !== contentPath(itemId)) return res.writeHead(404).end();
  writeHeaders(res, payload);
  res.end(payload);
}

function testPublication(name, run) {
  for (const linkError of [undefined, 'EPERM', 'ENOTSUP']) {
    const label = linkError ? ` (link returns ${linkError})` : '';
    test(name + label, { timeout: 10000 }, t => run(t, linkError));
  }
}

testPublication('an interrupted download leaves no output and can retry the same path', async (t, linkError) => {
  let attempts = 0;
  const { download, outputPath, outputDir } = await fixture(t, (req, res) => {
    if (req.url !== contentPath(itemId)) return res.writeHead(404).end();
    writeHeaders(res, payload);
    if (attempts++ === 0) {
      res.write(payload.subarray(0, 8192));
      setTimeout(() => res.destroy(), 100);
    } else res.end(payload);
  }, linkError);
  const interrupted = await download();
  assert.equal(interrupted.code, 1);
  assert.equal(interrupted.stdout, '');
  assert.deepEqual(await readdir(outputDir), [], 'an interrupted transfer must leave the destination directory empty');

  const retry = await download();
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), { saved: outputPath });
  assert.deepEqual(await readFile(outputPath), payload);
  if (process.platform !== 'win32') assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(outputDir), ['document.bin']);
});

testPublication('downloading refuses to replace an existing file', async (t, linkError) => {
  const { download, outputPath, outputDir } = await fixture(t, servePayload, linkError);
  const existing = Buffer.from('original file');
  await writeFile(outputPath, existing);

  const result = await download();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readFile(outputPath), existing);
  assert.deepEqual(await readdir(outputDir), ['document.bin']);
});

testPublication('competing downloads publish exactly one complete file', async (t, linkError) => {
  const payloads = [payload, Buffer.alloc(payload.length, 0x5a)];
  const responses = [];
  const { download, outputPath, outputDir } = await fixture(t, (req, res) => {
    const index = [contentPath(itemId), contentPath(otherItemId)].indexOf(req.url);
    if (index === -1) return res.writeHead(404).end();
    responses.push({ res, buffer: payloads[index] });
    if (responses.length < 2) return;
    for (const { res, buffer } of responses) {
      writeHeaders(res, buffer);
      res.end(buffer);
    }
  }, linkError);
  const results = await Promise.all([download(), download(otherItemId)]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  const winner = results.findIndex(result => result.code === 0);
  assert.deepEqual(JSON.parse(results[winner].stdout), { saved: outputPath });
  assert.equal(results[1 - winner].stdout, '');
  assert.deepEqual(await readFile(outputPath), payloads[winner]);
  assert.deepEqual(await readdir(outputDir), ['document.bin']);
});

test('an unexpected publication error leaves the destination empty', { timeout: 10000 }, async t => {
  const { download, outputDir } = await fixture(t, servePayload, 'EIO');
  const result = await download();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(outputDir), []);
});
