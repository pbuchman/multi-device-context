import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('../../skills/multi-device-context/scripts/mdc.mjs', import.meta.url));
const deviceId = '10000000-0000-4000-8000-000000000001';
const secondDeviceId = '10000000-0000-4000-8000-000000000002';
const contextId = '20000000-0000-4000-8000-000000000001';
const itemId = '30000000-0000-4000-8000-000000000001';
const device = { id: deviceId, name: 'Łódź MacBook' };
const devices = { records: [device] };

// Run the portable CLI as shipped, with only the network boundary replaced.
// All credentials and responses are synthetic; no real configuration is read.
async function run(args, responses = [], options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mdc-cli-'));
  const config = join(dir, 'config.json');
  const requests = join(dir, 'requests.jsonl');
  const preload = join(dir, 'fetch.mjs');
  await writeFile(config, JSON.stringify({ url: 'https://synthetic.invalid', key: 'mdc_synthetic_test_key' }), { mode: 0o600 });
  if (options.mode) await chmod(config, options.mode);
  await writeFile(preload, `
    import { appendFileSync } from 'node:fs';
    const responses = ${JSON.stringify(responses)};
    globalThis.fetch = async (url, init) => {
      appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ url, method: init.method, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined }) + '\\n');
      const next = responses.shift();
      if (!next) throw new Error('Unexpected request');
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: next.headers });
    };
  `);
  try {
    const child = spawn(process.execPath, ['--import', preload, cli, ...args], { env: { ...process.env, MDC_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    let captured = [];
    try { captured = (await readFile(requests, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { code, stdout, stderr, requests: captured };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const resultPage = records => ({ records, cursor: null, hasMore: false });
const path = request => new URL(request.url).pathname;
const query = request => new URL(request.url).searchParams;

test('devices lists only account devices through the agent endpoint', async () => {
  const result = await run(['devices'], [{ body: devices }]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), devices);
  assert.equal(path(result.requests[0]), '/api/agent/v1/devices');
});

test('list resolves a trimmed case-insensitive exact Unicode device name before querying', async () => {
  const result = await run(['list', '--device', '  łÓDŹ macBOOK  ', '--limit', '2', '--after', 'opaque'], [{ body: devices }, { body: resultPage([{ id: contextId }]) }]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(path(result.requests[0]), '/api/agent/v1/devices');
  assert.equal(query(result.requests[1]).get('deviceId'), deviceId);
  assert.equal(query(result.requests[1]).get('limit'), '2');
  assert.equal(query(result.requests[1]).get('after'), 'opaque');
});

test('missing and ambiguous names never query unfiltered contexts', async () => {
  for (const records of [[], [device, { id: secondDeviceId, name: ' łÓDŹ macBOOK ' }]]) {
    const result = await run(['latest', '--device', device.name], [{ body: { records } }]);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.match(result.stderr, records.length ? /ambiguous/i : /not found/i);
    if (records.length) { assert.match(result.stderr, new RegExp(deviceId)); assert.match(result.stderr, new RegExp(secondDeviceId)); }
  }
});

test('latest selects descending first context then reads every item page', async () => {
  const context = { id: contextId, originDeviceId: deviceId };
  const result = await run(['latest', '--device-id', deviceId, '--limit', '7'], [
    { body: resultPage([context]) }, { body: context },
    { body: { records: [{ id: itemId }], hasMore: true, cursor: 'item-page-2' } },
    { body: resultPage([{ id: 'second-item' }]) },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { context, items: [{ id: itemId }, { id: 'second-item' }] });
  assert.equal(query(result.requests[0]).get('deviceId'), deviceId);
  assert.equal(query(result.requests[0]).get('order'), 'desc');
  assert.equal(query(result.requests[0]).get('limit'), '1');
  assert.equal(path(result.requests[1]), `/api/agent/v1/contexts/${contextId}`);
  assert.equal(query(result.requests[2]).get('limit'), '7');
  assert.equal(query(result.requests[3]).get('after'), 'item-page-2');
});

test('unfiltered latest and empty latest are explicit', async () => {
  const result = await run(['latest'], [{ body: resultPage([]) }]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { context: null, items: [], message: 'No contexts found' });
  assert.equal(query(result.requests[0]).get('deviceId'), null);
  assert.equal(query(result.requests[0]).get('order'), 'desc');
  assert.equal(result.requests.length, 1);
});

test('device ID list bypasses name lookup', async () => {
  const result = await run(['list', '--device-id', deviceId], [{ body: resultPage([]) }]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(query(result.requests[0]).get('deviceId'), deviceId);
});

test('invalid filters, empty names and incompatible options fail before sending requests', async () => {
  for (const args of [
    ['list', '--device-id', 'invalid'], ['list', '--device', '   '], ['latest', '--device'],
    ['list', '--device', device.name, '--device-id', deviceId],
    ['get', contextId, '--device', device.name], ['latest', '--after', 'cursor'],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1, `${args}: ${result.stdout}`);
    assert.equal(result.requests.length, 0, args.join(' '));
  }
});

test('authentication and rate limits stop lookup without leaking key or response content', async () => {
  for (const status of [401, 403, 429]) {
    const result = await run(['latest', '--device', device.name], [{ status, headers: { 'retry-after': '12' }, body: { error: 'mdc_secret_response' } }]);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.match(result.stderr, new RegExp(`API returned ${status}`));
    if (status === 429) assert.match(result.stderr, /12 seconds/);
    assert.doesNotMatch(result.stderr + result.stdout, /mdc_synthetic|mdc_secret/);
  }
});

test('existing get reads item pagination', async () => {
  const context = { id: contextId };
  const result = await run(['get', contextId], [
    { body: context }, { body: { records: [{ id: itemId }], hasMore: true, cursor: 'next' } }, { body: resultPage([{ id: 'last' }]) },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).items, [{ id: itemId }, { id: 'last' }]);
  assert.equal(query(result.requests[2]).get('after'), 'next');
});

test('latest never returns a partial conversation when item pagination cannot advance', async () => {
  for (const pages of [
    [{ body: { records: [], hasMore: true, cursor: null } }],
    [{ body: { records: [], hasMore: true, cursor: 'loop' } }, { body: { records: [], hasMore: true, cursor: 'loop' } }],
  ]) {
    const result = await run(['latest'], [{ body: resultPage([{ id: contextId }]) }, { body: { id: contextId } }, ...pages]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /pagination/i);
  }
});

test('append preserves immutable item request shape and explicit UUID across retries', async () => {
  for (let retry = 0; retry < 2; retry++) {
    const result = await run(['append', contextId, '--text', 'Synthetic release note', '--item-id', itemId], [{ body: { id: contextId } }]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(path(result.requests[0]), `/api/agent/v1/contexts/${contextId}/items`);
    assert.equal(result.requests[0].method, 'POST');
    assert.equal(result.requests[0].redirect, 'error');
    assert.deepEqual(result.requests[0].body, { id: itemId, content: { kind: 'text', text: 'Synthetic release note' } });
    assert.equal(JSON.parse(result.stdout).itemId, itemId);
  }
});

test('configuration permissions remain protected before requests', { skip: process.platform === 'win32' }, async () => {
  const result = await run(['list'], [], { mode: 0o644 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /mode 0600/);
  assert.equal(result.requests.length, 0);
});
