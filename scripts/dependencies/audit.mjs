#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];

// A failed request, malformed report or unexpected child exit must never become a clean audit.
export function evaluateAudit(result) {
  if (result.error) throw result.error;
  if (result.signal || !Number.isInteger(result.status) || ![0, 1].includes(result.status)) {
    throw new Error(`Audit process failed (${result.signal ?? result.status}).`);
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('Audit returned invalid JSON.'); }
  const counts = report?.metadata?.vulnerabilities;
  if (report?.error || !report?.advisories || Array.isArray(report.advisories) || typeof report.advisories !== 'object' ||
      !counts || !severities.every(level => Number.isSafeInteger(counts[level]) && counts[level] >= 0)) {
    throw new Error('Audit failed without a complete advisory report.');
  }
  const advisories = Object.values(report.advisories);
  if (advisories.some(item => !item || !severities.includes(item.severity))) throw new Error('Audit returned an unknown advisory severity.');
  const findings = advisories.map(item => ({
    package: item.module_name, severity: item.severity, advisory: item.github_advisory_id,
    patched: item.patched_versions, paths: item.findings?.flatMap(finding => finding.paths ?? []) ?? [],
  }));
  const blocked = findings.filter(item => ['high', 'critical'].includes(item.severity));
  const passed = counts.high === 0 && counts.critical === 0 && blocked.length === 0;
  if (passed && result.status !== 0) throw new Error('Audit exited unsuccessfully without a high/critical finding.');
  return { passed, vulnerabilities: counts, findings, blocked };
}

export function runAudit({ cwd = path.resolve(import.meta.dirname, '../..'), run = spawnSync } = {}) {
  return evaluateAudit(run('pnpm', ['audit', '--audit-level', 'high', '--json'], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }));
}

export function main() {
  const result = runAudit();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
