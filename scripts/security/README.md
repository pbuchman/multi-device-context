# Patched transitive dependencies

`pnpm test:security` runs before the application tests in `pnpm test`, including
GitHub Actions Quality. It tests the installed dependencies through their actual
consumer chains, not copies of their code.

Two advisory exceptions apply only alongside exact dependency overrides and
checked-in pnpm patches. Tests verify every affected lockfile snapshot and
reference uses its pinned patch. Frozen installs verify patch integrity.

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
  entries; positive-lifetime stale reuse remains supported.

The advisory service identifies package versions, not our patch contents, so
`pnpm audit` reports these two advisories as explicitly ignored. Other findings
still fail CI. Do not add blanket severity or unfixable-advisory exclusions.

Remove each override, patch, exception and corresponding guard only after an
upstream replacement passes the exploit regression tests. In particular,
`http-cache-semantics@4.3.0` still reproduces the max-stale vulnerability despite
being outside the advisory's currently listed affected range.

The Electron download toolchain pins `@electron/get>global-agent` to 4.1.3,
which removes the `roarr` / `sprintf-js` chain affected by
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
A subprocess regression exercises the actual Electron proxy bootstrap with a
local synthetic HTTP proxy. No new audit exception is needed. `source-map-js`
is updated to 1.2.2 for
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
