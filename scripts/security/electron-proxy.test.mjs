import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Bootstrap replaces Node's global agents: isolate it from other tests.
test('Electron download tooling keeps proxy support without sprintf-js', () => {
  const lock = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(lock, /sprintf-js@|roarr@/);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { createRequire } from 'node:module';
    let require = createRequire(${JSON.stringify(fileURLToPath(new URL('../../apps/desktop/package.json', import.meta.url)))});
    for (const name of ['electron-builder', 'app-builder-lib']) require = createRequire(require.resolve(name));
    const get = require('@electron/get');
    const proxy = http.createServer((request, response) => {
      assert.equal(request.url, 'http://download.invalid/synthetic');
      response.end('proxied');
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://127.0.0.1:' + proxy.address().port;
    process.env.GLOBAL_AGENT_NO_PROXY = '';
    get.initializeProxy();
    try {
      const body = await new Promise((resolve, reject) => {
        http.get('http://download.invalid/synthetic', response => {
          let data = ''; response.on('data', chunk => data += chunk);
          response.on('end', () => resolve(data));
        }).on('error', reject);
      });
      assert.equal(body, 'proxied');
    } finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});
