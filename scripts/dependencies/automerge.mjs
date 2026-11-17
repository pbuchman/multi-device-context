#!/usr/bin/env node
// Only run this file from the trusted base checkout in pull_request_target.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eligiblePatch, manifestPatchOnly, requiredCiProtection } from './policy.mjs';

export function enableAutoMerge({ event, env = process.env, run = execFileSync }) {
  const repository = env.MDC_GITHUB_REPOSITORY ?? '';
  const number = event?.pull_request?.number;
  const expectedSha = event?.pull_request?.head?.sha;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 ||
      !/^[a-f0-9]{40}$/.test(expectedSha ?? '')) throw new Error('Invalid pull request event.');
  const options = { encoding: 'utf8', env: { ...env, GH_TOKEN: env.MDC_GITHUB_TOKEN ?? '' }, maxBuffer: 32 * 1024 * 1024 };
  const api = (endpoint, flags = []) => JSON.parse(run('gh', ['api', ...flags, endpoint], options));
  const endpoint = `repos/${repository}/pulls/${number}`;
  const pr = api(endpoint);
  // Fetch every page. Count/uniqueness checks reject partial or truncated API reports.
  const pages = api(`${endpoint}/files?per_page=100`, ['--paginate', '--slurp']);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Invalid paginated file report.');
  const files = pages.flat();
  const input = { pr, repository, expectedSha, files,
    updateType: env.MDC_UPDATE_TYPE ?? '', dependencyNames: env.MDC_DEPENDENCY_NAMES ?? '' };
  if (!eligiblePatch(input)) return { enabled: false, reason: 'Patch identity, metadata or files require manual review.' };
  for (const { filename } of files) {
    if (!filename.endsWith('package.json')) continue;
    const manifest = ref => {
      const content = api(`repos/${repository}/contents/${filename}?ref=${ref}`);
      if (content?.encoding !== 'base64' || typeof content.content !== 'string') throw new Error('Invalid manifest response.');
      return JSON.parse(Buffer.from(content.content, 'base64').toString('utf8'));
    };
    if (!manifestPatchOnly(manifest(pr.base.sha), manifest(expectedSha))) {
      return { enabled: false, reason: `Manifest requires manual review: ${filename}` };
    }
  }
  if (!requiredCiProtection(api(`repos/${repository}/branches/main`))) {
    throw new Error('Protected main with ci enforced for everyone from GitHub Actions (15368) is mandatory.');
  }
  const current = api(endpoint);
  if (!eligiblePatch({ ...input, pr: current }) || current.base.sha !== pr.base.sha) {
    throw new Error('Pull request changed during policy checks.');
  }
  run('gh', ['pr', 'merge', String(number), '--repo', repository, '--auto', '--squash', '--match-head-commit', expectedSha],
    { ...options, stdio: 'inherit' });
  return { enabled: true };
}

export function main() {
  const event = JSON.parse(readFileSync(process.env.MDC_GITHUB_EVENT_PATH ?? '', 'utf8'));
  const result = enableAutoMerge({ event });
  process.stdout.write(result.enabled ? 'Protected patch auto-merge enabled.\n' : `${result.reason}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
