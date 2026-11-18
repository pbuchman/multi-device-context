import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export const patchedAdvisories = {
  'GHSA-vfj7-8cjw-p6xm': { name: 'braces', overrides: { braces: '3.0.3' } },
  'GHSA-ch52-4w7c-c8xp': { name: 'http-cache-semantics', overrides: { 'http-cache-semantics': '4.2.0' } },
  'GHSA-fc5q-39xc-vjpf': { name: 'picomatch', overrides: { 'picomatch@2': '2.3.2', 'picomatch@4': '4.0.7' } },
};

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'];

function verifySnapshots(lock, name, patchedVersions) {
  const prefix = `${name}@`;
  const versionKeys = keys => keys.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort();
  assert.deepEqual(versionKeys(Object.keys(lock.packages)), [...patchedVersions.keys()].sort(), `Unexpected locked ${name} versions`);
  const expected = [...patchedVersions.values()].sort();
  assert.deepEqual(versionKeys(Object.keys(lock.snapshots)), expected, `All ${name} snapshots must use reviewed patches`);

  const references = new Set();
  const peerPrefix = `(${prefix}`;
  const addPeerReferences = reference => {
    for (const peer of reference.split(peerPrefix).slice(1)) {
      const version = expected.find(value => peer.startsWith(`${value})`));
      assert.ok(version, `All ${name} peer references must use reviewed patches`);
      references.add(version);
    }
  };
  for (const snapshot of Object.keys(lock.snapshots)) addPeerReferences(snapshot);
  for (const entry of [...Object.values(lock.importers), ...Object.values(lock.snapshots)]) {
    for (const section of dependencySections) {
      for (const [alias, dependency] of Object.entries(entry[section] ?? {})) {
        const reference = typeof dependency === 'string' ? dependency : dependency.version;
        if (alias === name && !reference?.startsWith(prefix)) references.add(reference);
        if (reference?.startsWith(prefix)) references.add(reference.slice(prefix.length));
        addPeerReferences(reference ?? '');
      }
    }
  }
  assert.deepEqual(references, new Set(expected), `All ${name} references must use reviewed patches`);
}

export function readAuditManifest(cwd, readFile = readFileSync) {
  const manifest = JSON.parse(readFile(path.join(cwd, 'package.json'), 'utf8'));
  let workspace;
  try {
    workspace = parse(readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const config of [manifest.pnpm?.auditConfig, workspace?.auditConfig]) {
    const empty = value => value === undefined || (Array.isArray(value) && value.length === 0);
    assert.ok(empty(config?.ignoreGhsas) && empty(config?.ignoreCves), 'Audit requires unfiltered pnpm advisories');
  }
  return manifest;
}

export function verifyPatchedAdvisories(cwd, readFile = readFileSync) {
  const manifest = readAuditManifest(cwd, readFile);
  const lock = parse(readFile(path.join(cwd, 'pnpm-lock.yaml'), 'utf8'));
  assert.equal(lock.lockfileVersion, '9.0', 'Review patch verification when the lockfile format changes');

  return new Map(Object.entries(patchedAdvisories).map(([advisory, { name, overrides }]) => {
    const patchedVersions = new Map();
    for (const [selector, version] of Object.entries(overrides)) {
      assert.equal(manifest.pnpm.overrides[selector], version);
      assert.equal(lock.overrides[selector], version);
      const packageVersion = `${name}@${version}`;
      const patchPath = `patches/${packageVersion}.patch`;
      assert.equal(manifest.pnpm.patchedDependencies[packageVersion], patchPath);
      const hash = createHash('sha256').update(readFile(path.join(cwd, patchPath))).digest('hex');
      assert.deepEqual(lock.patchedDependencies[packageVersion], { hash, path: patchPath }, `Patch hash or path differs for ${packageVersion}`);
      patchedVersions.set(version, `${version}(patch_hash=${hash})`);
    }
    verifySnapshots(lock, name, patchedVersions);
    return [advisory, new Set(patchedVersions.keys())];
  }));
}
