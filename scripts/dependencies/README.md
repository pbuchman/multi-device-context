# Dependency security policy

Quality runs the existing application, migration, security, secret-scan and
packaging checks in `quality`, with an independent `audit` job. The required
`ci` job always runs and passes only when both jobs succeed. A failed, cancelled
or skipped job therefore blocks merging.

`pnpm security:audit` runs `pnpm audit --audit-level high --json` for the whole
workspace, including development dependencies. High and critical findings block;
low and moderate findings remain visible with package, advisory and dependency
paths. Registry failures, malformed reports and unsuccessful child processes
fail closed. The existing two patch-backed advisory exceptions are preserved;
this policy adds none.

Dependabot checks npm and GitHub Actions weekly on Monday at 06:00 Europe/Warsaw.
The npm version-update PR limit is ten. Each ecosystem groups security updates;
GitHub's separate security-update mechanism can open them before the weekly
version-update check. Repository Dependabot alerts/security updates must be
enabled for that mechanism.

The auto-merge workflow runs policy code from the trusted PR base SHA using
`pull_request_target`. It never installs or executes the PR checkout. It accepts
only open, ready, same-repository PRs against `main` from the authentic
`dependabot[bot]` account (Bot ID 49699333), with patch metadata. Every changed
file is fetched with pagination and checked against the reported count. Only
modified root/workspace `package.json` files and `pnpm-lock.yaml` qualify.
Manifest edits may only increase existing dependency patch versions while
retaining the prefix, major and minor. New dependencies, overrides, scripts,
workflows, minor/major updates and GitHub Actions PRs require manual review.

Before enabling auto-merge, the policy checks that `main` is protected with `ci`
required from GitHub Actions (App ID 15368), enforced for everyone. It rechecks
the PR head and base SHA, then uses squash auto-merge bound to that head SHA.
It never approves PRs, bypasses protections or merges with administrator powers.
GitHub waits for the required check before merging.

Run locally from the workspace root:

```sh
pnpm test:dependencies
pnpm security:audit
pnpm security:repair          # preview; no writes or commands
pnpm security:repair --apply  # reviewed changes, ignored install scripts, audit
pnpm install --frozen-lockfile
pnpm test:security
```

Repair only targets the reviewed minimums: `get-uri>basic-ftp` 6.2.4,
`@hono/node-server` 2.1.6, `hono` 4.13.17 and `fast-xml-parser` 5.12.0.
New transitive overrides use bounded selectors within those majors. Since pnpm
matches declared ranges, repair also checks the current lockfile and refuses a
plan that could downgrade a newer resolution. Existing declarations/overrides
retain newer versions and range prefixes; unsupported ranges or majors require
review. The command is
idempotent and preserves the current patches and audit exceptions. Apply
regenerates the lockfile with `--ignore-scripts` and reports the audit; failures
leave the working-tree changes available for inspection. It never runs an
arbitrary `audit fix` or introduces a major migration.
