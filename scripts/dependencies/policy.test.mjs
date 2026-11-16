import assert from 'node:assert/strict';
import test from 'node:test';
import { eligiblePatch, isPatchVersion, manifestPatchOnly, requiredCiProtection } from './policy.mjs';

const repository = 'pbuchman/multi-device-context', sha = 'a'.repeat(40);
const valid = () => ({ repository, expectedSha: sha, updateType: 'version-update:semver-patch', dependencyNames: 'hono',
  files: [{ filename: 'package.json', status: 'modified' }, { filename: 'pnpm-lock.yaml', status: 'modified' }],
  pr: { user: { login: 'dependabot[bot]', id: 49699333, type: 'Bot' }, state: 'open', draft: false, changed_files: 2,
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: repository } }, head: { sha, repo: { full_name: repository } } } });

test('only strictly increasing same-prefix same-major same-minor patches qualify', () => {
  for (const [a, b] of [['1.2.3', '1.2.4'], ['^1.2.3', '^1.2.4'], ['~1.2.3', '~1.2.4']]) assert.equal(isPatchVersion(a, b), true);
  for (const [a, b] of [['1.2.3', '1.3.0'], ['1.2.3', '2.2.4'], ['1.2.3', '^1.2.4'], ['^1.2.3', '~1.2.4'],
    ['1.2.3', '1.2.2'], ['1.2.3', '1.2.3'], ['1.2.3', '1.2.4-beta.1'], ['1.2.3', '1.2.4 || *'], ['01.2.3', '01.2.4'],
    ['workspace:*', '1.2.4'], [null, '1.2.4'], ['1.2.3', 4]]) assert.equal(isPatchVersion(a, b), false, `${a} -> ${b}`);
});

test('manifest patch policy accepts all existing dependency sections and rejects configuration edits', () => {
  const before = { name: 'test', scripts: { test: 'node test.mjs' }, pnpm: { overrides: { dep: '1.0.0' } },
    dependencies: { dep: '^1.2.3', local: 'workspace:*' }, devDependencies: { dev: '~2.3.4' },
    peerDependencies: { peer: '3.4.5' }, optionalDependencies: { optional: '4.5.6' } };
  const after = structuredClone(before);
  after.dependencies.dep = '^1.2.4'; after.devDependencies.dev = '~2.3.5';
  after.peerDependencies.peer = '3.4.6'; after.optionalDependencies.optional = '4.5.7';
  assert.equal(manifestPatchOnly(before, after), true);
  const mutations = [
    value => { value.scripts.test = 'curl attacker'; },
    value => { value.pnpm.overrides.dep = '1.0.1'; },
    value => { value.dependencies.new = '1.2.4'; },
    value => { delete value.dependencies.dep; },
    value => { value.dependencies.dep = '^1.3.0'; },
    value => { value.dependencies.dep = '~1.2.4'; },
    value => { value.dependencies = []; },
    value => { value.dependencies = null; },
    value => { value.newConfig = true; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(after); mutate(changed); assert.equal(manifestPatchOnly(before, changed), false); }
  assert.equal(manifestPatchOnly(null, after), false);
});

test('authentic Dependabot identity, same repository and complete modified file list are mandatory', () => {
  assert.equal(eligiblePatch(valid()), true);
  const mutations = [
    input => { input.pr.user.id = 1; }, input => { input.pr.user.type = 'User'; }, input => { input.pr.user.login = 'dependabot'; },
    input => { input.pr.state = 'closed'; }, input => { input.pr.draft = true; }, input => { input.pr.base.ref = 'other'; },
    input => { input.pr.base.repo.full_name = 'fork/repo'; }, input => { input.pr.head.repo.full_name = 'fork/repo'; },
    input => { input.pr.head.sha = 'c'.repeat(40); }, input => { input.pr.base.sha = 'not-a-sha'; },
    input => { input.updateType = 'version-update:semver-minor'; }, input => { input.dependencyNames = ' '; },
    input => { input.files[0].filename = '.github/workflows/quality.yml'; }, input => { input.files[0].filename = 'scripts/dependencies/policy.mjs'; },
    input => { input.files[0].filename = 'apps/nested/path/package.json'; }, input => { input.files[0].status = 'renamed'; },
    input => { input.files[0].status = 'added'; }, input => { input.files[0].status = 'removed'; },
    input => { input.files.pop(); }, input => { input.files[0] = input.files[1]; }, input => { input.files = []; },
  ];
  for (const mutate of mutations) { const input = valid(); mutate(input); assert.equal(eligiblePatch(input), false); }
});

test('branch protection must enforce required GitHub Actions ci for everyone', () => {
  const branch = { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', checks: [{ context: 'ci', app_id: 15368 }] } } };
  assert.equal(requiredCiProtection(branch), true);
  for (const bad of [null, {}, { protected: true }, { ...branch, protected: false },
    { protected: true, protection: { required_status_checks: { enforcement_level: 'non_admins', checks: [{ context: 'ci', app_id: 15368 }] } } },
    { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', checks: [{ context: 'verify', app_id: 15368 }] } } },
    { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', checks: [{ context: 'ci', app_id: null }] } } }]) {
    assert.equal(requiredCiProtection(bad), false);
  }
});
