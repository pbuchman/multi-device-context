# Native artifact retention implementation plan

**Goal:** Keep only the latest successful main installer pair automatically.
**Architecture:** Trusted serialized cleanup workflow, pure selection policy, paginated GitHub API adapter. Native workflow only publishes successful main builds.
**Tech Stack:** Node.js built-in test runner, GitHub REST API via actions/github-script.

## Constraints
Exact names native-win-x64 and native-mac-arm64; workflow path .github/workflows/native-installers.yml; branch main; events push/workflow_dispatch; preserve active and unrelated runs; no deletion without a complete successful replacement; retain 14-day expiry; no additional dependencies.

## Tasks
- [x] Add scripts/ci/artifact-retention.test.mjs with fixtures for older/newer successes, out-of-order completion, incomplete/failed/PR builds, active runs, unrelated names/workflows, duplicates, expired artifacts, API failures and 404 deletion races. Run `node --test scripts/ci/*.test.mjs` and observe missing implementation.
- [x] Implement scripts/ci/artifact-retention.mjs exporting planCleanup(artifacts, runs) and cleanupArtifacts({github, context, core, dryRun}). Selection returns keep/delete artifact arrays; adapter paginates, retrieves each distinct run, plans before deletion and logs a summary. Run the same tests to green.
- [x] Add .github/workflows/artifact-retention.yml for workflow_run completed, daily cron and manual dry-run toggle, serialized concurrency and job-scoped write permission. Pin official actions. Always checkout main without persisted credentials. Modify native-installers.yml upload condition to success/main/push-or-manual. Add the Node test command to Quality.
- [x] Validate YAML with actionlint, run retention and existing runtime tests, read-only preview against GitHub. Review diff/security and create a PR with test evidence and operational limits.

Validation: 12 retention tests and 8 existing runtime tests pass; actionlint 1.7.12 passes on all modified/new workflow files. Read-only live API preview keeps IDs 11223701616 and 11223436721 (348.73 MiB), removes 68 artifacts (11.931 GiB). Reviewer identified a mixed listing/status snapshot race; a failing regression was added and the fix protects newer successful incomplete snapshots.
