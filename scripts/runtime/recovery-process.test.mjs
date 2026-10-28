import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { runRuntime } from './start.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'apps/server/package.json'));
const { build } = require('esbuild');
const lifecycle = JSON.stringify(join(root, 'apps/server/src/lifecycle.ts'));
const watchdog = JSON.stringify(join(root, 'apps/server/src/io-watchdog.ts'));
async function bundle(path, contents) {
  await build({ stdin: { contents, resolveDir: root, sourcefile: 'recovery-fixture.ts' }, bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: path, logLevel: 'silent' });
}

test('a real startup child without keepalive reaches watchdog recovery exit instead of silently exiting zero', { timeout: 4000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mdc-startup-hang-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'startup.mjs');
  await bundle(entry, `
    import { RecoveryLifecycle } from ${lifecycle};
    import { IoWatchdog } from ${watchdog};
    const recovery = new RecoveryLifecycle({ gracefulMs: 20, forcedMs: 40 });
    const io = new IoWatchdog(() => recovery.request('io-timeout'));
    await io.run('cleanup-firestore', () => new Promise(() => {}), 20).catch(() => {});
  `);
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let logs = ''; child.stderr.on('data', data => { logs += data; });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 75); assert.equal(signal, null);
  assert.equal(logs.includes('"outcome":"timeout"'), true);
  assert.equal(logs.includes('"outcome":"forced"'), true);
});

test('a real hung-close child uses the production fifteen-second forced exit bound', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mdc-forced-exit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'forced.mjs');
  await bundle(entry, `
    import { RecoveryLifecycle } from ${lifecycle};
    const recovery = new RecoveryLifecycle();
    recovery.attach({ close: () => new Promise(() => {}), forceClose() {} });
    recovery.request('io-timeout');
  `);
  const started = performance.now();
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let logs = ''; child.stderr.on('data', data => { logs += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 75);
  assert.ok(performance.now() - started < 17_000, 'exit must occur at fifteen seconds with process scheduling tolerance');
  assert.equal(logs.includes('"outcome":"forced"'), true);
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`real child recovery retains configuration, waits for prior exit, and stops on ${signal}`, { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mdc-child-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, 'apps/server/dist');
  await mkdir(dist, { recursive: true });
  await mkdir(join(dir, 'apps/web/dist'), { recursive: true });
  await writeFile(join(dir, 'apps/web/dist/index.html'), '<html></html>');
  const events = join(dir, 'events.jsonl');
  await bundle(join(dist, 'index.js'), `
    import { appendFileSync, readFileSync, existsSync } from 'node:fs';
    import { RecoveryLifecycle } from ${lifecycle};
    import { IoWatchdog } from ${watchdog};
    const events = ${JSON.stringify(events)};
    const previous = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\\n').map(JSON.parse) : [];
    let overlap = false;
    if (previous.length) { try { process.kill(previous.at(-1).pid, 0); overlap = true; } catch {} }
    appendFileSync(events, JSON.stringify({ pid: process.pid, credential: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      value: process.env.MDC_TEST_RETAINED, web: process.env.MDC_WEB_DIST, overlap }) + '\\n');
    if (!previous.length) {
      const recovery = new RecoveryLifecycle({ gracefulMs: 20, forcedMs: 40 });
      recovery.attach({ close: () => new Promise(() => {}), forceClose() {} });
      const io = new IoWatchdog(() => recovery.request('io-timeout'));
      await io.run('cleanup-firestore', () => new Promise(() => {}), 20).catch(() => {});
    } else {
      process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0));
      setInterval(() => {}, 1000);
    }
  `);
  const signals = new EventEmitter(), children = [], delays = [], logs = [];
  let loads = 0;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  t.after(() => { signals.emit('SIGTERM'); for (const child of children) child.kill('SIGKILL'); });
  const completion = runRuntime({
    bootstrapFile: 'synthetic-loader-only', applicationRoot: dir, checkConfig: false,
    load: async () => {
      loads++;
      if (loads > 1) throw new Error('Secret Manager unavailable after initial startup');
      return { environment: { MDC_TEST_RETAINED: 'retained-local-value', GOOGLE_APPLICATION_CREDENTIALS: '/private/synthetic-runtime-key.json' } };
    },
    supervisorOptions: {
      signals, log: event => logs.push(event),
      setTimer: (callback, delay) => { delays.push(delay); return setTimeout(callback, delay === 15_000 ? 1000 : 5); },
      spawnChild: (...args) => {
        const child = spawn(...args); children.push(child);
        if (children.length === 2) {
          const poll = setInterval(async () => {
            try { if ((await readFile(events, 'utf8')).trim().split('\n').length === 2) { clearInterval(poll); readyResolve(); } } catch {}
          }, 5);
          t.after(() => clearInterval(poll));
        }
        return child;
      },
    },
  });
  await ready;
  const records = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[0].credential, records[1].credential);
  assert.equal(records[1].value, 'retained-local-value');
  assert.equal(records[1].web, join(dir, 'apps/web/dist'));
  assert.equal(records[1].overlap, false);
  assert.equal(loads, 1);
  assert.deepEqual(delays, [1000]);
  assert.equal(logs[0].reason, 'io-timeout');
  signals.emit(signal);
  assert.equal(await completion, 0);
  assert.equal(children.length, 2);
});
