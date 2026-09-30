const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
module.exports = async ({ appDir }) => {
  const manifest = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  assert.equal(Object.keys(manifest.optionalDependencies ?? {}).length, 0);
  // esbuild already bundles the complete runtime closure. Tell electron-builder
  // explicitly that dependency collection is external, so it cannot fall back
  // to the monorepo root's PM2 dependencies.
  return false;
};
