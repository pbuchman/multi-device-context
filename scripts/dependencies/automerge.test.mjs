import assert from 'node:assert/strict';
import test from 'node:test';
import { enableAutoMerge } from './automerge.mjs';

const repository = 'pbuchman/multi-device-context', sha = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture({ files = [{ filename: 'package.json', status: 'modified' }, { filename: 'pnpm-lock.yaml', status: 'modified' }],
  branch = { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', checks: [{ context: 'ci', app_id: 15368 }] } } },
  mutateCurrent, after = { dependencies: { hono: '4.13.17' } }, failEndpoint } = {}) {
  const calls = [], pr = { user: { login: 'dependabot[bot]', id: 49699333, type: 'Bot' }, state: 'open', draft: false,
    changed_files: files.length, base: { ref: 'main', sha: base, repo: { full_name: repository } }, head: { sha, repo: { full_name: repository } } };
  let reads = 0;
  return { calls, pr, event: { pull_request: { number: 7, head: { sha } } },
    env: { MDC_GITHUB_REPOSITORY: repository, MDC_GITHUB_TOKEN: 'test-token', MDC_UPDATE_TYPE: 'version-update:semver-patch', MDC_DEPENDENCY_NAMES: 'hono' },
    run(command, args, options) {
      calls.push({ command, args, options });
      assert.equal(command, 'gh'); assert.equal(options.env.GH_TOKEN, 'test-token');
      if (args[0] === 'pr') return '';
      const endpoint = args.at(-1);
      if (endpoint === failEndpoint) throw new Error('GitHub API unavailable');
      if (endpoint.endsWith('/pulls/7')) {
        const current = structuredClone(pr);
        if (reads++ > 0 && mutateCurrent) mutateCurrent(current);
        return JSON.stringify(current);
      }
      if (endpoint.includes('/files?')) {
        assert.deepEqual(args.slice(0, 3), ['api', '--paginate', '--slurp']);
        return JSON.stringify([files.slice(0, 100), ...(files.length > 100 ? [files.slice(100)] : [])]);
      }
      if (endpoint.includes('/contents/')) {
        const manifest = endpoint.endsWith(`ref=${base}`) ? { dependencies: { hono: '4.13.12' } } : after;
        return JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64') });
      }
      if (endpoint.endsWith('/branches/main')) return JSON.stringify(branch);
      throw new Error(`Unexpected API request: ${endpoint}`);
    } };
}
const merges = fixture => fixture.calls.filter(call => call.args[0] === 'pr');

test('trusted policy enables only head-bound squash auto-merge after live protection checks', () => {
  const input = fixture();
  assert.equal(enableAutoMerge(input).enabled, true);
  assert.deepEqual(merges(input)[0].args, ['pr', 'merge', '7', '--repo', repository, '--auto', '--squash', '--match-head-commit', sha]);
  assert.equal(input.calls.filter(call => call.args.at(-1).endsWith('/pulls/7')).length, 2);
  assert.equal(input.calls.some(call => call.command !== 'gh'), false);
});

test('pagination permits eligible manifests beyond first hundred files', () => {
  const files = Array.from({ length: 101 }, (_, i) => ({ filename: `apps/pkg${i}/package.json`, status: 'modified' }));
  const input = fixture({ files });
  assert.equal(enableAutoMerge(input).enabled, true);
  assert.equal(input.calls.filter(call => call.args.at(-1).includes('/contents/')).length, 202);
});

test('workflow hidden on second page, partial file reports and duplicate names cannot merge', () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ filename: `packages/pkg${i}/package.json`, status: 'modified' }));
  files.push({ filename: '.github/workflows/inject.yml', status: 'modified' });
  const hidden = fixture({ files });
  assert.equal(enableAutoMerge(hidden).enabled, false); assert.equal(merges(hidden).length, 0);
  const partial = fixture(); partial.pr.changed_files++;
  assert.equal(enableAutoMerge(partial).enabled, false); assert.equal(merges(partial).length, 0);
  const duplicate = fixture({ files: [{ filename: 'package.json', status: 'modified' }, { filename: 'package.json', status: 'modified' }] });
  assert.equal(enableAutoMerge(duplicate).enabled, false); assert.equal(merges(duplicate).length, 0);
});

test('script/override edits fail manual review without executing PR code', () => {
  for (const after of [{ dependencies: { hono: '4.13.17' }, scripts: { preinstall: 'attack' } },
    { dependencies: { hono: '4.13.17' }, pnpm: { overrides: { other: '1.0.0' } } },
    { dependencies: { hono: '4.13.17', surprise: '1.0.0' } }]) {
    const input = fixture({ after }); assert.equal(enableAutoMerge(input).enabled, false); assert.equal(merges(input).length, 0);
  }
});

test('missing protection, API failure, changed head and changed base all fail closed', () => {
  for (const options of [{ branch: {} }, { failEndpoint: `repos/${repository}/branches/main` },
    { mutateCurrent: pr => { pr.head.sha = 'c'.repeat(40); } },
    { mutateCurrent: pr => { pr.base.sha = 'c'.repeat(40); } },
    { mutateCurrent: pr => { pr.draft = true; } }]) {
    const input = fixture(options);
    assert.throws(() => enableAutoMerge(input)); assert.equal(merges(input).length, 0);
  }
});
