import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateAudit, runAudit } from './audit.mjs';

function report(severity) {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  if (severity) vulnerabilities[severity]++;
  return { advisories: severity ? { finding: { module_name: 'fixture', severity, github_advisory_id: 'GHSA-fixture', findings: [{ paths: ['consumer>fixture'] }] } } : {},
    metadata: { vulnerabilities } };
}
const result = (payload, status = 0) => ({ status, signal: null, stdout: JSON.stringify(payload) });

test('all dependencies are audited at high threshold, including development dependencies', () => {
  let called = false;
  const audit = runAudit({ run(command, args) {
    called = true; assert.equal(command, 'pnpm');
    assert.deepEqual(args, ['audit', '--audit-level', 'high', '--json']);
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
    result(report(), 1), result({ advisories: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } } }),
    result({ ...report(), advisories: { unknown: { severity: 'surprise' } } })]) {
    assert.throws(() => evaluateAudit(bad));
  }
});

test('actual audit CLI propagates high findings and registry errors as nonzero child exits', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mdc-audit-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'pnpm');
  const auditScript = fileURLToPath(new URL('./audit.mjs', import.meta.url));
  for (const [payload, status, expected] of [[report('moderate'), 0, 0], [report('high'), 1, 1],
    [{ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }, 1, 1], [report(), 2, 1]]) {
    writeFileSync(executable, `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['audit','--audit-level','high','--json'])) process.exit(9);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(${status});\n`);
    chmodSync(executable, 0o755);
    const child = spawnSync(process.execPath, [auditScript], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` } });
    assert.equal(child.status, expected, child.stderr);
  }
});
