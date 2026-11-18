import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPatchedAdvisories } from '../dependencies/patched-advisories.mjs';

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

const pm2Anymatch = dependency('../../package.json', ['pm2', 'chokidar', 'anymatch']);
const tinyglobby = dependency('../../package.json', ['vitest', 'tinyglobby']);

for (const [consumer, chain] of [
  ['PM2', ['pm2', 'chokidar', 'anymatch']],
  ['Firebase CLI', ['firebase-tools', 'chokidar', 'anymatch']],
  ['Vitest', ['vitest']],
  ['tinyglobby', ['vitest', 'tinyglobby']],
]) {
  const picomatch = dependency('../../package.json', [...chain, 'picomatch']);
  test(`${consumer} rejects repeated extglobs before compiling a matcher`, () => {
    const rejected = { name: 'SyntaxError', message: /Repeated extglobs are disabled/ };

    // Literal words make these harmless even on an unpatched install.
    assert.throws(() => picomatch.parse('src/+(docs)'), rejected);
    assert.throws(() => picomatch.makeRe('./src/*(docs|help)', { maxExtglobRecursion: false }), rejected);
    assert.throws(() => picomatch(['src/**/*.md', '@(help|+(docs))']), rejected);
  });

  test(`${consumer} preserves regular globs and non-repeating extglobs`, () => {
    assert.equal(picomatch.isMatch('src/help/intro.md', 'src/**/*.md'), true);
    assert.equal(picomatch.isMatch('src/help/intro.txt', 'src/**/*.md'), false);
    assert.equal(picomatch.isMatch('src/docs', 'src/@(docs|help)'), true);
    assert.equal(picomatch.isMatch('src/docs', 'src/!(archive)'), true);
    assert.equal(picomatch.isMatch('+(docs)', '\\+\\(docs\\)'), true);
    assert.equal(picomatch.compileRe(picomatch.parse('src/**/*.md')).test('src/help/intro.md'), true);
  });
}

test('PM2 file watching and Vitest glob discovery use the installed matchers', () => {
  assert.equal(pm2Anymatch('src/**/*.ts', 'src/routes/chats.ts'), true);
  assert.equal(pm2Anymatch('src/**/*.ts', 'src/routes/chats.js'), false);
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const files = tinyglobby.globSync('scripts/security/*.test.mjs', { cwd });
  assert.ok(files.includes('scripts/security/patched-dependencies.test.mjs'));
  assert.ok(files.every(file => file.endsWith('.test.mjs')));
});

test('every audit exception has exact reviewed versions and patched lockfile references', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  assert.deepEqual(verifyPatchedAdvisories(cwd), new Map([
    ['GHSA-vfj7-8cjw-p6xm', new Set(['3.0.3'])],
    ['GHSA-ch52-4w7c-c8xp', new Set(['4.2.0'])],
    ['GHSA-fc5q-39xc-vjpf', new Set(['2.3.2', '4.0.7'])],
  ]));
});
