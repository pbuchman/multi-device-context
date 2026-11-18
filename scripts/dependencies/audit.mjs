#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchedAdvisories, readAuditManifest, verifyPatchedAdvisories } from './patched-advisories.mjs';

const severities = ['info', 'low', 'moderate', 'high', 'critical'];

// A failed request, malformed report or unexpected child exit must never become a clean audit.
export function evaluateAudit(result, verifiedVersions = () => undefined) {
  if (result.error) throw result.error;
  if (result.signal || !Number.isInteger(result.status) || ![0, 1].includes(result.status)) {
    throw new Error(`Audit process failed (${result.signal ?? result.status}).`);
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('Audit returned invalid JSON.'); }
  const counts = report?.metadata?.vulnerabilities;
  if (report?.error || !report?.advisories || Array.isArray(report.advisories) || typeof report.advisories !== 'object' ||
      !counts || Object.keys(counts).length !== severities.length ||
      !severities.every(level => Number.isSafeInteger(counts[level]) && counts[level] >= 0)) {
    throw new Error('Audit failed without a complete advisory report.');
  }
  const advisories = Object.values(report.advisories);
  if (advisories.some(item => !item || !severities.includes(item.severity))) throw new Error('Audit returned an unknown advisory severity.');
  const findings = advisories.map(item => ({
    package: item.module_name, severity: item.severity, advisory: item.github_advisory_id,
    patched: item.patched_versions, paths: item.findings?.flatMap(finding => finding.paths ?? []) ?? [],
  }));
  const locallyPatched = [], blocked = [];
  const coveredCounts = { high: 0, critical: 0 };
  const coveredAdvisories = new Set();
  for (const [index, finding] of findings.entries()) {
    const { advisory, package: name, severity } = finding;
    if (severity !== 'high' && severity !== 'critical') continue;
    const versions = verifiedVersions(advisory, name);
    const affected = advisories[index].findings;
    if (!versions || coveredAdvisories.has(advisory) || !Array.isArray(affected) || affected.length === 0 ||
        affected.some(item => !versions.has(item?.version) || !Array.isArray(item.paths) || item.paths.length === 0 ||
          item.paths.some(path => typeof path !== 'string' || path.split('>').at(-1) !== name)) ||
        new Set(affected.map(item => item.version)).size !== affected.length) {
      blocked.push(finding);
      continue;
    }
    coveredAdvisories.add(advisory);
    coveredCounts[severity] += affected.length;
    locallyPatched.push({ ...finding, versions: affected.map(item => item.version) });
  }
  // Refuse to account for a registry count without a complete reported finding.
  const passed = blocked.length === 0 && counts.high === coveredCounts.high && counts.critical === coveredCounts.critical;
  if (passed && result.status !== Number(findings.length > 0)) throw new Error('Audit exit status disagrees with the advisory report.');
  return { passed, vulnerabilities: counts, findings, blocked, locallyPatched };
}

export function runAudit({ cwd = path.resolve(import.meta.dirname, '../..'), run = spawnSync } = {}) {
  readAuditManifest(cwd);
  let verifiedPatches;
  // Reset pnpm's production-only and development-only selectors. Include optional dependencies.
  const args = ['audit', '--audit-level', 'low', '--json',
    '--config.production=false', '--config.dev=false', '--config.optional=true', '--config.only='];
  return evaluateAudit(run('pnpm', args, {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }), (advisory, name) => {
    if (!Object.hasOwn(patchedAdvisories, advisory) || patchedAdvisories[advisory].name !== name) return;
    verifiedPatches ??= verifyPatchedAdvisories(cwd);
    return verifiedPatches.get(advisory);
  });
}

export function main() {
  const result = runAudit();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
