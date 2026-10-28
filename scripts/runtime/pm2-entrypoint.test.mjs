import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const container = require.resolve('pm2/lib/ProcessContainerFork.js');
const source = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(t, mode, recover = false) {
  const root = await mkdtemp(join(tmpdir(), 'mdc-pm2-entry-'));
  const runtime = join(root, 'scripts/runtime');
  const entry = join(runtime, 'start.mjs');
  const state = join(root, 'generation');
  await mkdir(runtime, { recursive: true });
  await mkdir(join(root, 'apps/server/dist'), { recursive: true });
  await mkdir(join(root, 'apps/web/dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(root, 'apps/web/dist/index.html'), '<main>synthetic</main>');
  for (const name of ['start.mjs', 'supervisor.mjs']) await copyFile(join(source, name), join(runtime, name));
  await writeFile(join(runtime, 'package.mjs'), `
    export async function loadRuntime(file) {
      if (file !== 'synthetic-bootstrap-not-read') throw new Error('Unexpected fixture input');
      process.stdout.write(JSON.stringify({ event: 'loader', argvEntry: process.argv[1], pmEntry: process.env.pm_exec_path }) + '\\n');
      return { environment: { MDC_RETAINED: 'synthetic-retained-config', MDC_FIXTURE_STATE: ${JSON.stringify(state)}, MDC_RECOVER: '${recover}' } };
    }
  `);
  await writeFile(join(root, 'apps/server/dist/index.js'), `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    const state = process.env.MDC_FIXTURE_STATE;
    const generation = existsSync(state) ? Number(readFileSync(state, 'utf8')) + 1 : 1;
    writeFileSync(state, String(generation));
    const report = extra => process.stdout.write(JSON.stringify({ event: 'child', generation, pid: process.pid, retained: process.env.MDC_RETAINED, ...extra }) + '\\n');
    if (process.env.MDC_RECOVER === 'true' && generation === 1) {
      report({ recoveryExit: 75 });
      setTimeout(() => process.exit(75), 20);
    } else {
      const server = createServer((_request, response) => response.end(JSON.stringify({ status: 'synthetic', generation })));
      server.listen(0, '127.0.0.1', () => report({ port: server.address().port }));
      // Exit75 on the operator signal exercises the supervisor's stop-versus-recovery race.
      process.on('SIGTERM', () => server.close(() => process.exit(process.env.MDC_RECOVER === 'true' ? 75 : 0)));
    }
  `);
  const importer = join(root, 'importer.mjs');
  await writeFile(importer, `
    const runtime = await import('./scripts/runtime/start.mjs');
    if (typeof runtime.runRuntime !== 'function') throw new Error('Runtime export missing');
    process.stdout.write(JSON.stringify({ event: 'imported' }) + '\\n');
    process.exit(0);
  `);
  const pmEntry = mode === 'import' ? importer : entry;
  const child = spawn(process.execPath, [mode === 'direct' ? entry : container], {
    cwd: root, detached: process.platform !== 'win32',
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      MDC_BOOTSTRAP_FILE: 'synthetic-bootstrap-not-read', PM2_HOME: join(root, 'private-pm2'),
      ...(mode === 'direct' ? {} : { pm_exec_path: pmEntry, pm_cwd: root }),
    },
    // The real fork-mode PM2 container gets the same IPC channel from ForkMode.js.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events = [];
  let buffered = '', stderr = '', exited = false;
  child.stdout.on('data', data => {
    buffered += data;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  child.on('error', () => { exited = true; });
  child.on('exit', () => { exited = true; });
  t.after(async () => {
    if (!exited) child.kill('SIGTERM');
    for (let attempt = 0; !exited && attempt < 25; attempt++) await delay(20);
    if (!exited) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        await new Promise(resolve => killer.once('close', resolve));
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
    for (let attempt = 0; !exited && attempt < 25; attempt++) await delay(20);
    await rm(root, { recursive: true, force: true });
  });
  const waitFor = async predicate => {
    const deadline = performance.now() + 5000;
    while (!predicate() && !exited && performance.now() < deadline) await delay(20);
    assert.ok(predicate(), `Expected synthetic entrypoint progress; events=${JSON.stringify(events)}, exited=${exited}, stderr=${stderr}`);
  };
  return { child, events, state, entry, waitFor };
}

for (const mode of ['direct', 'pm2']) test(`starts loader and supervised application through ${mode} entrypoint`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, mode);
  await f.waitFor(() => f.events.some(event => event.event === 'loader') && f.events.some(event => event.port));
  const loader = f.events.find(event => event.event === 'loader');
  assert.equal(loader.argvEntry, mode === 'pm2' ? container : f.entry);
  if (mode === 'pm2') assert.equal(loader.pmEntry, f.entry);
  const application = f.events.find(event => event.port);
  assert.equal(application.retained, 'synthetic-retained-config');
  const response = await fetch(`http://127.0.0.1:${application.port}/health/live`, { signal: AbortSignal.timeout(1000) });
  assert.deepEqual(await response.json(), { status: 'synthetic', generation: 1 });
});

test('PM2 container retains one loaded configuration through child exit 75 recovery and operator stop', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'pm2', true);
  await f.waitFor(() => f.events.some(event => event.generation === 2 && event.port));
  const children = f.events.filter(event => event.event === 'child');
  assert.deepEqual(children.map(event => event.generation), [1, 2]);
  assert.equal(f.events.filter(event => event.event === 'loader').length, 1);
  assert.equal(alive(children[0].pid), false, 'the exited child must be gone before replacement starts');
  assert.equal(children[0].retained, children[1].retained);
  f.child.kill('SIGTERM');
  const deadline = performance.now() + 2000;
  while (alive(children[1].pid) && performance.now() < deadline) await delay(20);
  assert.equal(alive(children[1].pid), false, 'operator stop must reach the supervised child');
  await delay(1100);
  assert.equal(await readFile(f.state, 'utf8'), '2', 'operator stop must suppress recovery even when child exits 75');
});

test('importing the runtime from another PM2 entrypoint keeps runRuntime side-effect free', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'import');
  await f.waitFor(() => f.events.some(event => event.event === 'imported'));
  assert.equal(f.events.some(event => event.event === 'loader' || event.event === 'child'), false);
});
