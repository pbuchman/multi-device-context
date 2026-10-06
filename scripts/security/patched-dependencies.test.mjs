import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function dependency(root, chain) {
  let require = createRequire(new URL(root, import.meta.url));
  for (const name of chain.slice(0, -1)) require = createRequire(require.resolve(name));
  return require(chain.at(-1));
}
const braces = dependency('../../package.json', ['pm2', 'chokidar', 'braces']);
const CachePolicy = dependency('../../apps/desktop/package.json', ['electron-builder', 'app-builder-lib', '@electron/get', 'got', 'cacheable-request', 'http-cache-semantics']);

for (const method of ['parse', 'compile', 'expand', 'stringify']) {
  test(`braces ${method} rejects excessive brace and parenthesis nesting predictably`, () => {
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      const pattern = open.repeat(4500) + 'a' + close.repeat(4500);
      assert.throws(() => braces[method](pattern), error => error instanceof SyntaxError && /nesting/.test(error.message));
    }
  });
}
for (const method of ['compile', 'expand', 'stringify']) {
  test(`braces ${method} cannot bypass depth validation with a supplied AST`, () => {
    let ast = { type: 'text', value: 'a', nodes: [] };
    for (let i = 0; i < 4500; i++) ast = { type: 'root', nodes: [ast] };
    assert.throws(() => braces[method](ast), error => error instanceof SyntaxError && /nesting/.test(error.message));
    const cycle = { type: 'root', nodes: [] }; cycle.nodes.push(cycle);
    assert.throws(() => braces[method](cycle), /nesting/);
  });
}
test('braces retains ordinary expansion, regex compilation, quoting and nesting', () => {
  assert.deepEqual(braces.expand('file-{a,b}-{1..3}'), ['file-a-1', 'file-a-2', 'file-a-3', 'file-b-1', 'file-b-2', 'file-b-3']);
  assert.equal(braces.compile('a/{b,c}/d'), 'a/(b|c)/d');
  assert.equal(braces.stringify(braces.parse('a/{b,{c,d}}')), 'a/{b,{c,d}}');
  assert.deepEqual(braces.expand('\\{a,b\\}'), ['{a,b}']);
  const boundary = '{'.repeat(126) + 'a' + '}'.repeat(126);
  assert.doesNotThrow(() => braces.compile(boundary));
});

const request = { url: 'https://example.test/account', method: 'GET', headers: { host: 'example.test' } };
const staleRequest = { ...request, headers: { ...request.headers, 'cache-control': 'max-stale=999999' } };
for (const headers of [
  { 'set-cookie': 'session=private; HttpOnly', 'cache-control': 'max-age=3600' },
  { 'cache-control': 'proxy-revalidate, max-age=3600' },
  { 'cache-control': 'no-cache, max-age=3600' },
  { 'cache-control': 'no-store' },
  { 'cache-control': 'private, max-age=3600' },
  { vary: '*', 'cache-control': 'max-age=3600' },
]) {
  test(`max-stale cannot reuse security-zeroed shared cache: ${JSON.stringify(headers)}`, () => {
    const policy = new CachePolicy(request, { status: 200, headers }, { shared: true });
    assert.equal(policy.maxAge(), 0);
    assert.equal(policy.satisfiesWithoutRevalidation(staleRequest), false);
    assert.equal(policy.evaluateRequest(staleRequest).response, undefined);
  });
}
test('normal fresh caching and permitted stale responses still work', () => {
  for (const headers of [{ 'cache-control': 'max-age=60' }, { 'cache-control': 'public, max-age=60', 'set-cookie': 'explicit-public-cookie' }]) {
    const policy = new CachePolicy(request, { status: 200, headers }, { shared: true });
    assert.equal(policy.satisfiesWithoutRevalidation(request), true);
    const now = policy.now(); policy.now = () => now + 120_000;
    assert.equal(policy.satisfiesWithoutRevalidation(request), false);
    assert.equal(policy.satisfiesWithoutRevalidation(staleRequest), true);
  }
});

test('audit exceptions cover only exact patched package versions throughout the lockfile', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.match(lock, /^lockfileVersion: '9\.0'/);
  const snapshots = lock.split('\nsnapshots:\n');
  assert.equal(snapshots.length, 2, 'Review this guard when the lockfile format changes');
  const expected = [
    ['braces', '3.0.3', 'GHSA-vfj7-8cjw-p6xm'],
    ['http-cache-semantics', '4.2.0', 'GHSA-ch52-4w7c-c8xp'],
    ['sprintf-js', '1.1.3', 'GHSA-hp3w-g68c-fv3c'],
  ];
  assert.deepEqual(manifest.pnpm.auditConfig.ignoreGhsas, expected.map(([, , advisory]) => advisory));
  for (const [name, version] of expected) {
    assert.equal(manifest.pnpm.overrides[name], version);
    const patchPath = `patches/${name}@${version}.patch`;
    assert.equal(manifest.pnpm.patchedDependencies[`${name}@${version}`], patchPath);
    const escapedVersion = version.replaceAll('.', '\\.');
    const patch = lock.match(new RegExp(`^  ${name}@${escapedVersion}:\\n    hash: ([a-f0-9]+)\\n    path: ${patchPath.replaceAll('.', '\\.')}$`, 'm'));
    assert.ok(patch, `${name} must have a pinned patch hash`);
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../../${patchPath}`, import.meta.url))).digest('hex'), patch[1]);
    const expectedSelector = `${name}@${version}(patch_hash=${patch[1]})`;
    const selectors = [...snapshots[1].matchAll(new RegExp(`^  ['"]?(${name}@[^:'"\\n]+)['"]?:`, 'gm'))].map(match => match[1]);
    assert.deepEqual(selectors, [expectedSelector], `${name}: every installed snapshot must use the reviewed patch`);
    const references = [...snapshots[1].matchAll(new RegExp(`^ +['"]?${name}['"]?: ['"]?([^'"\\n]+)['"]?$`, 'gm'))].map(match => match[1]);
    assert.ok(references.length > 0);
    assert.ok(references.every(value => value === `${version}(patch_hash=${patch[1]})`), `${name}: unpatched dependency reference`);
  }
});
