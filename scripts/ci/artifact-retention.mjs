const names = new Set(['native-win-x64', 'native-mac-arm64']);
const workflowPath = '.github/workflows/native-installers.yml';

/** Select a complete successful pair before considering any destructive operation. */
export function planCleanup(artifacts, runs) {
  const byId = new Map(runs.map(run => [run.id, run]));
  const scoped = artifacts.filter(artifact => {
    if (!names.has(artifact.name) || artifact.expired) return false;
    const run = byId.get(artifact.workflow_run?.id);
    if (!run) throw new Error(`Missing workflow run for artifact ${artifact.id}`);
    return run.path === workflowPath;
  });
  const candidates = runs.filter(run => run.path === workflowPath &&
    run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event) &&
    run.status === 'completed' && run.conclusion === 'success' &&
    [...names].every(name => scoped.some(a => a.workflow_run.id === run.id && a.name === name)))
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt || b.id - a.id);
  const winner = candidates[0];
  if (!winner) return {keep: [], remove: []};
  const keep = [...names].map(name => scoped.filter(a => a.workflow_run.id === winner.id && a.name === name)
    .sort((a, b) => b.id - a.id)[0]);
  const keepIds = new Set(keep.map(a => a.id));
  return {keep, remove: scoped.filter(a => {
    const run = byId.get(a.workflow_run.id);
    // Listing artifacts and reading run status are not atomic. A newer run
    // may finish uploading after our snapshot; never delete that partial view.
    const newerSuccessfulMain = run.run_number > winner.run_number &&
      run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event) &&
      run.conclusion === 'success';
    return !keepIds.has(a.id) && run.status === 'completed' && !newerSuccessfulMain;
  })};
}

/** Read-only by default. github/context/core are supplied by actions/github-script. */
export async function cleanupArtifacts({github, context, core, dryRun = true}) {
  const repo = context.repo;
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, {...repo, per_page: 100});
  const runIds = [...new Set(artifacts.filter(a => names.has(a.name) && !a.expired)
    .map(a => a.workflow_run?.id))];
  const runs = [];
  for (const runId of runIds) {
    if (!runId) throw new Error('Artifact is missing workflow run metadata');
    const {data} = await github.rest.actions.getWorkflowRun({...repo, run_id: runId});
    runs.push(data);
  }
  const plan = planCleanup(artifacts, runs);
  const bytes = plan.remove.reduce((sum, a) => sum + a.size_in_bytes, 0);
  core.info(`${dryRun ? 'Preview' : 'Cleanup'}: keep ${plan.keep.map(a => a.id).join(', ') || 'none'}; ` +
    `remove ${plan.remove.length} artifacts (${(bytes / 2 ** 30).toFixed(3)} GiB).`);
  if (dryRun || !plan.remove.length) return plan;

  // Recheck all involved runs before deleting: a manual rerun may have started
  // since listing. Never allow an active/changed winner to authorize deletion.
  const freshRuns = new Map();
  for (const id of new Set([...plan.keep, ...plan.remove].map(a => a.workflow_run.id))) {
    const {data} = await github.rest.actions.getWorkflowRun({...repo, run_id: id});
    freshRuns.set(id, data);
  }
  const winner = freshRuns.get(plan.keep[0].workflow_run.id);
  const originalWinner = runs.find(r => r.id === winner.id);
  if (winner.status !== 'completed' || winner.conclusion !== 'success' ||
      winner.run_attempt !== originalWinner.run_attempt) {
    core.info('Winning run changed; leave artifacts untouched until the next cleanup.');
    return plan;
  }
  for (const artifact of plan.remove) {
    const run = freshRuns.get(artifact.workflow_run.id);
    if (run.status !== 'completed' || run.run_attempt !== runs.find(r => r.id === run.id).run_attempt) continue;
    try {
      await github.rest.actions.deleteArtifact({...repo, artifact_id: artifact.id});
      core.info(`Deleted artifact ${artifact.id} (${artifact.name}).`);
    } catch (error) {
      if (error.status !== 404) throw error;
      core.info(`Artifact ${artifact.id} was already deleted.`);
    }
  }
  return plan;
}
