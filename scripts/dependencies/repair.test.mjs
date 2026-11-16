import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertNoLockedDowngrade, minimum, planRepairs, repair } from './repair.mjs';

const original = () => ({ name: 'fixture', scripts: { test: 'node test.mjs' }, dependencies: { unrelated: '1.0.0' },
  pnpm: { overrides: { 'get-uri>basic-ftp': '6.2.1', unrelated: '2.0.0' }, patchedDependencies: { 'patched@1.0.0': 'patches/patched.patch' },
    auditConfig: { ignoreGhsas: ['existing-patch-exception'] } } });

test('repair only advances known packages and preserves newer versions, prefixes and reviewed patches', () => {
  const input = original(), { manifest, changes } = planRepairs(input);
  assert.equal(changes.length, 4);
  assert.equal(input.pnpm.overrides['get-uri>basic-ftp'], '6.2.1');
  assert.deepEqual(manifest.scripts, input.scripts); assert.deepEqual(manifest.dependencies, input.dependencies);
  assert.deepEqual(manifest.pnpm.patchedDependencies, input.pnpm.patchedDependencies);
  assert.deepEqual(manifest.pnpm.auditConfig, input.pnpm.auditConfig);
  assert.equal(manifest.pnpm.overrides.unrelated, '2.0.0');
  assert.equal(planRepairs(manifest).changes.length, 0);
  manifest.pnpm.overrides['get-uri>basic-ftp'] = '6.3.0';
  assert.equal(planRepairs(manifest).manifest.pnpm.overrides['get-uri>basic-ftp'], '6.3.0');
  assert.equal(minimum('^4.13.12', '4.13.17'), '^4.13.17');
  assert.equal(minimum('4.14.0', '4.13.17'), '4.14.0');
  assert.equal(minimum('4.13.20', '4.13.17'), '4.13.20');
  for (const version of ['3.9.0', '5.0.0', '*', 'workspace:*', '>=4.0.0', '4.13.17-beta.1']) assert.throws(() => minimum(version, '4.13.17'));
});

test('new selectors constrain the reviewed major and direct declarations advance safely', () => {
  const { manifest } = planRepairs(original());
  assert.equal(manifest.pnpm.overrides['@hono/node-server@>=2.0.0 <2.1.6'], '2.1.6');
  assert.equal(manifest.pnpm.overrides['hono@>=4.0.0 <4.13.17'], '4.13.17');
  assert.equal(manifest.pnpm.overrides['fast-xml-parser@>=5.0.0 <5.12.0'], '5.12.0');
  const child = { dependencies: { hono: '4.13.12' }, devDependencies: { 'fast-xml-parser': '^5.11.2' } };
  const repaired = planRepairs(child, false);
  assert.equal(repaired.manifest.dependencies.hono, '4.13.17');
  assert.equal(repaired.manifest.devDependencies['fast-xml-parser'], '^5.12.0');
  assert.equal(Object.hasOwn(repaired.manifest, 'pnpm'), false);
});

test('newer locked versions fail review before pnpm can downgrade a broad declared range', () => {
  const { manifest } = planRepairs(original());
  for (const entry of ['hono@4.14.0', "'@hono/node-server@2.2.0'", 'fast-xml-parser@5.13.0', 'basic-ftp@6.3.0']) {
    assert.throws(() => assertNoLockedDowngrade(`lockfileVersion: '9.0'\npackages:\n  ${entry}:\n    resolution: {}\nsnapshots:\n`, manifest), /downgraded/);
  }
  assert.doesNotThrow(() => assertNoLockedDowngrade("lockfileVersion: '9.0'\npackages:\n  hono@4.13.12:\n  hono@5.0.0:\nsnapshots:\n", manifest));
  assert.throws(() => assertNoLockedDowngrade('unrecognized', manifest), /Unsupported lockfile/);
});

function workspace(t, child = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mdc-repair-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'apps/demo'), { recursive: true }); mkdirSync(path.join(root, 'packages'));
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(original(), null, 2)}\n`);
  writeFileSync(path.join(root, 'apps/demo/package.json'), `${JSON.stringify(child, null, 2)}\n`);
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages:\n  hono@4.13.12:\nsnapshots:\n");
  return root;
}
const clean = () => ({ status: 0, stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }) });

test('preview writes nothing and invokes no install or audit', t => {
  const root = workspace(t), before = readFileSync(path.join(root, 'package.json'), 'utf8');
  const preview = repair({ root, run() { throw new Error('Preview ran a command'); } });
  assert.equal(preview.applied, false); assert.equal(preview.changes.length, 4);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  assert.equal(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'), "lockfileVersion: '9.0'\npackages:\n  hono@4.13.12:\nsnapshots:\n");
});

test('apply regenerates lockfile with scripts disabled and audits, and second apply is idempotent', t => {
  const root = workspace(t, { dependencies: { hono: '4.13.12' } }), calls = [];
  const run = (command, args, options) => {
    calls.push(args); assert.equal(command, 'pnpm'); assert.equal(options.cwd, root);
    if (args[0] === 'install') { writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages:\n  hono@4.13.17:\nsnapshots:\n"); return { status: 0 }; }
    return clean();
  };
  const applied = repair({ root, apply: true, run });
  assert.equal(applied.applied, true); assert.equal(applied.audit.passed, true); assert.equal(applied.changes.length, 5);
  assert.deepEqual(calls, [['install', '--no-frozen-lockfile', '--ignore-scripts'], ['audit', '--audit-level', 'high', '--json']]);
  const before = readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.equal(repair({ root, apply: true, run }).changes.length, 0);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
});

test('unsupported workspace range fails before any manifest write', t => {
  const root = workspace(t, { dependencies: { hono: '3.9.0' } }), before = readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.throws(() => repair({ root, apply: true, run() { throw new Error('Should not install'); } }), /Unsupported major/);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
});

test('newer lockfile guard fails before writing manifests or executing install', t => {
  const root = workspace(t), before = readFileSync(path.join(root, 'package.json'), 'utf8');
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages:\n  hono@4.14.0:\nsnapshots:\n");
  assert.throws(() => repair({ root, apply: true, run() { throw new Error('Should not install'); } }), /downgraded/);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
});

test('install failures and audit errors fail closed; high findings remain blocking', t => {
  for (const failed of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('ENOENT') }]) {
    const root = workspace(t); let calls = 0;
    assert.throws(() => repair({ root, apply: true, run() { calls++; return failed; } })); assert.equal(calls, 1);
  }
  const root = workspace(t);
  assert.throws(() => repair({ root, apply: true, run(command, args) {
    return args[0] === 'install' ? { status: 0 } : { status: 1, stdout: '{"error":{"code":"REGISTRY_FAILURE"}}' };
  } }), /advisory report/);
  const blocked = repair({ root, apply: true, run(command, args) {
    const report = JSON.parse(clean().stdout); report.metadata.vulnerabilities.high = 1;
    return args[0] === 'install' ? { status: 0 } : { status: 1, stdout: JSON.stringify(report) };
  } });
  assert.equal(blocked.audit.passed, false);
});
