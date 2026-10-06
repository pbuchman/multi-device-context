import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

function dependency(root, chain) {
  let require = createRequire(new URL(root, import.meta.url));
  for (const name of chain.slice(0, -1)) require = createRequire(require.resolve(name));
  return { module: require(chain.at(-1)), path: require.resolve(chain.at(-1)) };
}

const sprintfDependency = dependency('../../apps/desktop/package.json', [
  'electron-builder',
  'app-builder-lib',
  '@electron/get',
  'global-agent',
  'roarr',
  'sprintf-js',
]);
const { sprintf, vsprintf } = sprintfDependency.module;

test('oversized numeric precision cannot terminate an unhandled formatter process', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const { sprintf } = require(${JSON.stringify(sprintfDependency.path)});
    const values = [
      sprintf('%.101f', 1),
      sprintf('%.101e', 1),
      sprintf('%.101g', 1),
      sprintf('%.999999999999999999999999f', 1),
    ];
    process.stdout.write(JSON.stringify(values));
  `], { encoding: 'utf8', timeout: 5_000 });

  assert.equal(child.signal, null, `formatter timed out with ${child.signal}`);
  assert.equal(child.status, 0, child.stderr);
  const [fixed, exponential, general, huge] = JSON.parse(child.stdout);
  assert.equal(fixed, `1.${'0'.repeat(100)}`);
  assert.equal(exponential, `1.${'0'.repeat(100)}e+0`);
  assert.equal(general, '1');
  assert.equal(huge, `1.${'0'.repeat(100)}`);
});

test('valid precision, padding, positional and non-numeric formats retain their behavior', () => {
  assert.equal(sprintf('%.2f', 1.235), '1.24');
  assert.equal(sprintf('%.0f', 1.6), '2');
  assert.equal(sprintf('%.2e', 12), '1.20e+1');
  assert.equal(sprintf('%.3g', 12.34), '12.3');
  assert.equal(sprintf('%.0g', 1), '1');
  assert.equal(sprintf('%010.2f', 12.3), '0000012.30');
  assert.equal(sprintf('%.5s', 'abcdef'), 'abcde');
  assert.equal(vsprintf('%2$s %1$04d', [7, 'ok']), 'ok 0007');
});

