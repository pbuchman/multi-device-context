import test from 'node:test';
import assert from 'node:assert/strict';
import { planCleanup, cleanupArtifacts } from './artifact-retention.mjs';

const win = 'native-win-x64';
const mac = 'native-mac-arm64';
const run = (id, overrides = {}) => ({ id, run_number: id, run_attempt: 1,
  path: '.github/workflows/native-installers.yml', head_branch: 'main',
  event: 'push', status: 'completed', conclusion: 'success', ...overrides });
const artifact = (id, runId, name = win, overrides = {}) => ({ id, name,
  expired: false, size_in_bytes: 100, workflow_run: { id: runId }, ...overrides });
const pair = (id) => [artifact(id * 10, id), artifact(id * 10 + 1, id, mac)];
const ids = (items) => items.map(a => a.id).sort((a, b) => a - b);

test('keeps the newest successful complete main pair, regardless of API/completion order', () => {
  const result = planCleanup([...pair(3), ...pair(1), ...pair(2)], [run(2), run(3), run(1)]);
  assert.deepEqual(ids(result.keep), [30, 31]);
  assert.deepEqual(ids(result.remove), [10, 11, 20, 21]);
});

test('failed, cancelled, PR and incomplete newer runs cannot replace a good pair', () => {
  const artifacts = [...pair(1), ...pair(2), ...pair(3), ...pair(4), artifact(50, 5)];
  const runs = [run(1), run(2, {conclusion: 'failure'}), run(3, {conclusion: 'cancelled'}),
    run(4, {event: 'pull_request'}), run(5)];
  assert.deepEqual(ids(planCleanup(artifacts, runs).keep), [10, 11]);
  assert.deepEqual(ids(planCleanup(artifacts, runs).remove), [20, 21, 30, 31, 40, 41]);
});

test('protects active runs, unrelated artifacts and other workflows even with matching names', () => {
  const artifacts = [...pair(1), ...pair(2), ...pair(3), artifact(99, 1, 'test-report')];
  const result = planCleanup(artifacts, [run(1), run(2, {status: 'in_progress', conclusion: null}),
    run(3, {path: '.github/workflows/other.yml'})]);
  assert.deepEqual(ids(result.keep), [10, 11]);
  assert.deepEqual(result.remove, []);
});

test('fails closed when no complete eligible pair exists or metadata is missing', () => {
  assert.deepEqual(planCleanup(pair(1), [run(1, {head_branch: 'feature'})]).remove, []);
  assert.deepEqual(planCleanup([artifact(10, 1)], [run(1)]).remove, []);
  assert.throws(() => planCleanup([...pair(1), ...pair(2)], [run(1)]), /Missing workflow run/);
});

test('expired artifacts cannot complete a pair; manual main builds can replace it', () => {
  const a = [...pair(1), ...pair(2), ...pair(3).map(x => ({...x, expired: x.name === mac}))];
  assert.deepEqual(ids(planCleanup(a, [run(1), run(2, {event: 'workflow_dispatch'}), run(3)]).keep), [20, 21]);
});

test('duplicate artifacts in the winning run keep only the latest ID per name', () => {
  const result = planCleanup([...pair(1), artifact(12, 1)], [run(1)]);
  assert.deepEqual(ids(result.keep), [11, 12]);
  assert.deepEqual(ids(result.remove), [10]);
});

function client({failRead = false, deleteStatus, activeOnRecheck = false} = {}) {
  const deleted = [], reads = new Map();
  const github = {rest: {actions: {
    listArtifactsForRepo: 'list-artifacts',
    getWorkflowRun: async ({run_id}) => {
      reads.set(run_id, (reads.get(run_id) || 0) + 1);
      if (failRead && run_id === 2) throw new Error('read failed');
      return {data: run(run_id, activeOnRecheck && run_id === 1 && reads.get(run_id) > 1
        ? {status: 'in_progress', conclusion: null} : {})};
    },
    deleteArtifact: async ({artifact_id}) => {
      if (deleteStatus) throw Object.assign(new Error('delete failed'), {status: deleteStatus});
      deleted.push(artifact_id);
    }
  }}, paginate: async (method, params) => {
    assert.equal(method, 'list-artifacts');
    assert.equal(params.per_page, 100);
    return [...pair(1), ...pair(2)];
  }};
  return {github, deleted, context: {repo: {owner: 'owner', repo: 'repo'}}, core: {info() {}}};
}

test('dry run lists a deletion plan without deleting', async () => {
  const c = client(); const result = await cleanupArtifacts({...c, dryRun: true});
  assert.deepEqual(ids(result.remove), [10, 11]); assert.deepEqual(c.deleted, []);
});

test('deletes only superseded artifacts with explicit write mode', async () => {
  const c = client(); await cleanupArtifacts({...c, dryRun: false});
  assert.deepEqual(c.deleted, [10, 11]);
});

test('read errors abort before any deletion', async () => {
  const c = client({failRead: true});
  await assert.rejects(cleanupArtifacts({...c, dryRun: false}), /read failed/);
  assert.deepEqual(c.deleted, []);
});

test('a rerun started after planning is protected', async () => {
  const c = client({activeOnRecheck: true}); await cleanupArtifacts({...c, dryRun: false});
  assert.deepEqual(c.deleted, []);
});

test('already-deleted artifacts are harmless but permission failures propagate', async () => {
  await cleanupArtifacts({...client({deleteStatus: 404}), dryRun: false});
  await assert.rejects(cleanupArtifacts({...client({deleteStatus: 403}), dryRun: false}), /delete failed/);
});

test('protects a newer successful run whose second upload was missing from the listing snapshot', () => {
  const result = planCleanup([...pair(1), artifact(20, 2)], [run(1), run(2)]);
  assert.deepEqual(ids(result.keep), [10, 11]);
  assert.deepEqual(result.remove, []);
});
