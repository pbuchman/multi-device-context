#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit } from './audit.mjs';

// Reviewed repairs only. No audit fix, arbitrary recommendations or major migrations.
const repairs = {
  'get-uri>basic-ftp': '6.2.4',
  '@hono/node-server@>=2.0.0 <2.1.6': '2.1.6',
  'hono@>=4.0.0 <4.13.17': '4.13.17',
  'fast-xml-parser@>=5.0.0 <5.12.0': '5.12.0',
};

export function minimum(current, target) {
  const pattern = /^([~^]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const a = typeof current === 'string' && pattern.exec(current), b = pattern.exec(target);
  if (!a || !b || a[2] !== b[2]) throw new Error(`Unsupported major/range: ${current} -> ${target}; review required.`);
  return BigInt(a[3]) > BigInt(b[3]) || (a[3] === b[3] && BigInt(a[4]) >= BigInt(b[4])) ? current : `${a[1]}${target}`;
}

// pnpm matches overrides against declared ranges, so a bounded selector alone
// cannot guarantee that an already newer lockfile resolution stays newer.
export function assertNoLockedDowngrade(lockfile, manifest) {
  const packages = lockfile.split('\npackages:\n');
  if (!/^lockfileVersion: '9\.0'/m.test(lockfile) || packages.length !== 2) {
    throw new Error('Unsupported lockfile format; review required before repair.');
  }
  const reviewed = [
    ['basic-ftp', 'get-uri>basic-ftp', 6],
    ['@hono/node-server', '@hono/node-server@>=2.0.0 <2.1.6', 2],
    ['hono', 'hono@>=4.0.0 <4.13.17', 4],
    ['fast-xml-parser', 'fast-xml-parser@>=5.0.0 <5.12.0', 5],
  ];
  const block = packages[1].split('\nsnapshots:\n')[0];
  for (const [name, selector, major] of reviewed) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = manifest.pnpm.overrides[selector];
    for (const match of block.matchAll(new RegExp(`^  ['"]?${escaped}@([^:'"\\n]+)['"]?:`, 'gm'))) {
      const locked = match[1];
      if (!locked.startsWith(`${major}.`)) continue;
      // minimum rejects unfamiliar prereleases/ranges rather than guessing.
      if (minimum(target, locked) !== target) {
        throw new Error(`Newer locked ${name}@${locked} could be downgraded by ${selector}: ${target}; review required.`);
      }
    }
  }
}

export function planRepairs(original, root = true) {
  const manifest = structuredClone(original), changes = [];
  if (root) {
    manifest.pnpm ??= {};
    manifest.pnpm.overrides ??= {};
    for (const [selector, target] of Object.entries(repairs)) {
      const current = manifest.pnpm.overrides[selector];
      const updated = current === undefined ? target : minimum(current, target);
      if (updated !== current) {
        manifest.pnpm.overrides[selector] = updated;
        changes.push(`pnpm.overrides.${selector}: ${current ?? '(none)'} -> ${updated}`);
      }
    }
  }
  // Preserve direct declarations if these reviewed packages become workspace dependencies.
  const direct = { 'basic-ftp': '6.2.4', '@hono/node-server': '2.1.6', hono: '4.13.17', 'fast-xml-parser': '5.12.0' };
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, target] of Object.entries(direct)) {
      if (!Object.hasOwn(manifest[section] ?? {}, name)) continue;
      const current = manifest[section][name], updated = minimum(current, target);
      if (updated !== current) {
        manifest[section][name] = updated;
        changes.push(`${section}.${name}: ${current} -> ${updated}`);
      }
    }
  }
  return { manifest, changes };
}

function workspaceFiles(root) {
  return ['package.json', ...['apps', 'packages'].flatMap(parent =>
    readdirSync(path.join(root, parent), { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const relative = `${parent}/${entry.name}/package.json`;
      try { readFileSync(path.join(root, relative)); return [relative]; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }))];
}

export function repair({ root = path.resolve(import.meta.dirname, '../..'), apply = false, run = spawnSync } = {}) {
  // Build the complete plan before writing anything, so an unsupported range fails before mutation.
  const plans = workspaceFiles(root).map(file => {
    const original = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    const { manifest, changes } = planRepairs(original, file === 'package.json');
    return { file, manifest, changes };
  });
  assertNoLockedDowngrade(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'), plans[0].manifest);
  const changes = plans.flatMap(plan => plan.changes.map(change => `${plan.file}: ${change}`));
  if (!apply) return { changes, applied: false };
  for (const plan of plans) if (plan.changes.length) writeFileSync(path.join(root, plan.file), `${JSON.stringify(plan.manifest, null, 2)}\n`);
  const install = run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (install.error) throw install.error;
  if (install.signal || install.status !== 0) throw new Error('Dependency install failed; inspect working-tree changes.');
  return { changes, applied: true, audit: runAudit({ cwd: root, run }) };
}

export function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('Usage: pnpm security:repair [--apply]');
  const result = repair({ apply: args.includes('--apply') });
  result.changes.forEach(change => process.stdout.write(`${change}\n`));
  if (!result.applied) process.stdout.write('Preview only. Use --apply to apply reviewed repairs, regenerate the lockfile and audit.\n');
  else {
    process.stdout.write(`${JSON.stringify(result.audit, null, 2)}\n`);
    if (!result.audit.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
