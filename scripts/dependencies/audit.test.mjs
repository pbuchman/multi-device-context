import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { evaluateAudit, runAudit } from './audit.mjs';
import { verifyPatchedAdvisories } from './patched-advisories.mjs';

function report(severity) {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  if (severity) vulnerabilities[severity]++;
  return { advisories: severity ? { finding: { module_name: 'fixture', severity, github_advisory_id: 'GHSA-fixture', findings: [{ paths: ['consumer>fixture'] }] } } : {},
    metadata: { vulnerabilities } };
}
const result = (payload, status = Number(Object.keys(payload.advisories ?? {}).length > 0)) => ({ status, signal: null, stdout: JSON.stringify(payload) });

test('the registry report retains lower severities and includes development dependencies', () => {
  let called = false;
  const audit = runAudit({ run(command, args) {
    called = true; assert.equal(command, 'pnpm');
    assert.deepEqual(args, ['audit', '--audit-level', 'low', '--json',
      '--config.production=false', '--config.dev=false', '--config.optional=true', '--config.only=']);
    return result(report('moderate'));
  } });
  assert.equal(called, true); assert.equal(audit.passed, true);
  assert.deepEqual(audit.findings, [{ package: 'fixture', severity: 'moderate', advisory: 'GHSA-fixture', patched: undefined, paths: ['consumer>fixture'] }]);
});

test('low/moderate pass and high/critical fail regardless of advisory versus aggregate representation', () => {
  for (const severity of [undefined, 'info', 'low', 'moderate']) assert.equal(evaluateAudit(result(report(severity))).passed, true);
  for (const severity of ['low', 'moderate']) {
    const audit = evaluateAudit(result(report(severity)));
    assert.equal(audit.findings[0].severity, severity); assert.equal(audit.findings[0].advisory, 'GHSA-fixture');
    assert.deepEqual(audit.blocked, []);
  }
  for (const severity of ['high', 'critical']) {
    const payload = report(severity);
    assert.equal(evaluateAudit(result(payload, 1)).passed, false);
    assert.equal(evaluateAudit(result(payload, 0)).passed, false);
    payload.advisories = {};
    assert.equal(evaluateAudit(result(payload, 1)).passed, false);
  }
});

test('registry errors, malformed reports, signals and failed children never pass', () => {
  for (const bad of [result({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }, 1),
    result({ ...report(), error: { message: 'registry unavailable' } }), result({}),
    { status: 0, stdout: 'not-json' }, { status: null, signal: 'SIGTERM', stdout: JSON.stringify(report()) },
    { status: 2, stdout: JSON.stringify(report()) }, { error: new Error('ENOENT') },
    result(report(), 1), result(report('moderate'), 0), result({ ...report(), metadata: { vulnerabilities: { ...report().metadata.vulnerabilities, unknown: 1 } } }),
    result({ advisories: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } } }),
    result({ ...report(), advisories: { unknown: { severity: 'surprise' } } })]) {
    assert.throws(() => evaluateAudit(bad));
  }
});

test('actual audit CLI propagates high findings and registry errors as nonzero child exits', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mdc-audit-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'pnpm');
  const auditScript = fileURLToPath(new URL('./audit.mjs', import.meta.url));
  for (const [payload, status, expected] of [[report('moderate'), 1, 0], [report('high'), 1, 1],
    [{ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }, 1, 1], [report(), 2, 1]]) {
    writeFileSync(executable, `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['audit','--audit-level','low','--json','--config.production=false','--config.dev=false','--config.optional=true','--config.only='])) process.exit(9);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(${status});\n`);
    chmodSync(executable, 0o755);
    const child = spawnSync(process.execPath, [auditScript], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` } });
    assert.equal(child.status, expected, child.stderr);
  }
});

test('only explicit findings on verified patched versions account for high counts', () => {
  const verified = (id, name) =>
    id === 'GHSA-fc5q-39xc-vjpf' && name === 'picomatch' ? new Set(['2.3.2', '4.0.7']) : undefined;
  const payload = report('high');
  payload.metadata.vulnerabilities.high = 2;
  payload.advisories.finding = {
    module_name: 'picomatch',
    severity: 'high',
    github_advisory_id: 'GHSA-fc5q-39xc-vjpf',
    findings: [
      { version: '2.3.2', paths: ['.>fixture>picomatch'] },
      { version: '4.0.7', paths: ['.>other>picomatch'] },
    ],
  };

  const audit = evaluateAudit(result(payload, 1), verified);
  assert.equal(audit.passed, true);
  assert.equal(audit.vulnerabilities.high, 2);
  assert.equal(audit.locallyPatched.length, 1);
  assert.deepEqual(audit.locallyPatched[0].versions, ['2.3.2', '4.0.7']);
  assert.deepEqual(audit.blocked, []);

  for (const change of [
    report => { report.metadata.vulnerabilities.high++; },
    report => { report.metadata.vulnerabilities.high--; },
    report => { report.advisories = {}; },
    report => { report.advisories.finding.findings.pop(); },
    report => { report.advisories.finding.findings[1].version = '4.0.6'; },
    report => { report.advisories.finding.findings[1].version = '2.3.2'; },
    report => { report.advisories.finding.findings[1].paths = []; },
    report => { report.advisories.finding.findings[1].paths = ['.>fixture>unrelated']; },
    report => { report.advisories.finding.github_advisory_id = 'GHSA-unrelated'; },
    report => { report.advisories.finding.module_name = 'unrelated'; },
    changed => { changed.advisories.extra = report('critical').advisories.finding; },
  ]) {
    const changed = structuredClone(payload);
    change(changed);
    assert.equal(evaluateAudit(result(changed, 1), verified).passed, false);
  }
});

test('audit rejects manifest and workspace filters before requesting advisories', t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'mdc-audit-filters-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const manifest = path.join(cwd, 'package.json');
  const run = () => assert.fail('Audit should reject filtering before running pnpm');
  writeFileSync(manifest, JSON.stringify({ pnpm: { auditConfig: { ignoreGhsas: ['GHSA-fixture'] } } }));
  assert.throws(() => runAudit({ cwd, run }), /unfiltered pnpm advisories/);

  writeFileSync(manifest, '{}');
  writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'auditConfig:\n  ignoreCves: [CVE-fixture]\n');
  assert.throws(() => runAudit({ cwd, run }), /unfiltered pnpm advisories/);
});

test('patch verification rejects changed bytes and unpatched snapshot, importer and peer references', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const lockPath = path.join(cwd, 'pnpm-lock.yaml');
  const lockfile = readFileSync(lockPath, 'utf8');
  for (const change of [
    lock => { lock.snapshots['picomatch@4.0.7'] = {}; },
    lock => { lock.importers['.'].devDependencies.matcher = { specifier: 'npm:picomatch@4.0.7', version: 'picomatch@4.0.7' }; },
    lock => { lock.snapshots['fixture@1.0.0(picomatch@4.0.7)'] = {}; },
  ]) {
    const lock = parse(lockfile);
    change(lock);
    const readFile = (file, encoding) => file === lockPath ? stringify(lock) : readFileSync(file, encoding);
    assert.throws(() => verifyPatchedAdvisories(cwd, readFile), /picomatch.*reviewed patches/);
  }
  const patchPath = path.join(cwd, 'patches/picomatch@4.0.7.patch');
  const readFile = (file, encoding) => file === patchPath ? 'corrupted patch' : readFileSync(file, encoding);
  assert.throws(() => verifyPatchedAdvisories(cwd, readFile), /Patch hash or path/);
});
