# Patched transitive dependencies

`pnpm test:security` runs before the application tests in `pnpm test`, including
GitHub Actions Quality. It tests the installed dependencies through their actual
consumer chains, not copies of their code.

Three advisory exceptions apply only alongside exact dependency overrides and
checked-in pnpm patches. Tests verify every affected lockfile snapshot and
reference uses its pinned patch. Frozen installs verify patch integrity.

When updating an existing checkout to this patch with pnpm 10.29.3, a normal
incremental install can link a Picomatch directory before applying the patch.
Use a clean checkout or run `pnpm install --force --frozen-lockfile`, then run
`pnpm test:security` to verify the code loaded by PM2 and the build tools.

- [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
  `braces@3.0.3` reaches production through PM2/Chokidar and development through
  Firebase tooling. The patch bounds brace/parenthesis parser nesting and
  iteratively checks caller-supplied AST depth before recursive walkers. Deep
  patterns raise a controlled `SyntaxError`, like existing input-length limits,
  rather than exhausting the stack. Callers should handle invalid patterns.
- [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp):
  `http-cache-semantics@4.2.0` comes through Electron build tooling. The patch
  requires revalidation for zero-lifetime entries before considering `max-stale`,
  preventing security restrictions on cached cookies/private responses from
  being bypassed. This conservatively also revalidates ordinary zero-lifetime
  entries. Positive-lifetime stale reuse remains supported.
- [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
  affects `picomatch@2.3.2` through PM2 and Firebase tooling and
  `picomatch@4.0.7` through Firebase tooling, Vite and Vitest. Both patches
  throw a `SyntaxError` when the glob parser encounters a repeating extglob,
  before it can generate a repeated regex group. This also rejects simple
  repetitions and applies regardless of `maxExtglobRecursion`. Ordinary
  globs, non-repeating extglobs and escaped literal syntax still work.
  Raw regular expressions, regex syntax embedded in a pattern and custom
  compiled output remain the caller's responsibility. Use ordinary glob
  patterns in MDC configuration and tooling.

The dependency audit retains the registry's findings and counts. It reports
a finding as locally patched only after verifying the advisory ID, package,
affected versions, and lockfile patch hashes and references. All other high
and critical findings block CI, including counts without matching finding
details. See the [dependency policy](../dependencies/README.md) for audit
and repair commands.

Remove each override, patch, exception and corresponding guard only after a
fixed upstream replacement passes the relevant regression tests. In particular,
`http-cache-semantics@4.3.0` still reproduces the max-stale vulnerability despite
being outside the advisory's currently listed affected range.

The Electron download toolchain pins `@electron/get>global-agent` to 4.1.3,
which removes the `roarr` / `sprintf-js` chain affected by
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
A subprocess regression exercises the actual Electron proxy bootstrap with a
local synthetic HTTP proxy. No new audit exception is needed. `source-map-js`
is updated to 1.2.2 for
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
