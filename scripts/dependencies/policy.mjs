import { isDeepStrictEqual } from 'node:util';

const versionPattern = /^([~^]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (a, b) => isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());

export function isPatchVersion(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const a = versionPattern.exec(before), b = versionPattern.exec(after);
  return !!a && !!b && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && BigInt(b[4]) > BigInt(a[4]);
}

// Existing dependency entries may move forward by patch, with the same range prefix.
// Scripts, overrides, dependency additions/removals and other configuration require review.
export function manifestPatchOnly(before, after) {
  if (!record(before) || !record(after) || !sameKeys(before, after)) return false;
  const allowed = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
  for (const key of Object.keys(before)) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    if (!allowed.has(key)) return false;
    const a = before[key], b = after[key];
    if (!record(a) || !record(b) || !sameKeys(a, b)) return false;
    if (!Object.keys(a).every(name => a[name] === b[name] || isPatchVersion(a[name], b[name]))) return false;
  }
  return true;
}

export function eligiblePatch({ pr, repository, expectedSha, updateType, dependencyNames, files }) {
  return !!(
    /^[\w.-]+\/[\w.-]+$/.test(repository) &&
    pr?.user?.login === 'dependabot[bot]' && pr.user.id === 49699333 && pr.user.type === 'Bot' &&
    pr.state === 'open' && pr.draft === false && pr.base?.ref === 'main' &&
    pr.base.repo?.full_name === repository && pr.head?.repo?.full_name === repository &&
    /^[a-f0-9]{40}$/.test(expectedSha) && pr.head.sha === expectedSha &&
    /^[a-f0-9]{40}$/.test(pr.base.sha) &&
    updateType === 'version-update:semver-patch' && typeof dependencyNames === 'string' &&
    dependencyNames.trim().length > 0 && Array.isArray(files) && files.length > 0 &&
    Number.isSafeInteger(pr.changed_files) && pr.changed_files === files.length &&
    new Set(files.map(file => file?.filename)).size === files.length &&
    files.every(file => file?.status === 'modified' &&
      /^(?:pnpm-lock\.yaml|package\.json|(?:apps|packages)\/[^/]+\/package\.json)$/.test(file.filename))
  );
}

export function requiredCiProtection(branch) {
  return branch?.protected === true &&
    branch.protection?.required_status_checks?.enforcement_level === 'everyone' &&
    Array.isArray(branch.protection.required_status_checks.checks) &&
    branch.protection.required_status_checks.checks.some(check => check.context === 'ci' && check.app_id === 15368);
}
