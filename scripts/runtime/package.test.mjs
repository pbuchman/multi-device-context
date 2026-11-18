import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadRuntime, provisionRuntime } from './package.mjs';

const execute = promisify(execFile);
const source = dirname(fileURLToPath(import.meta.url));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'mdc-local-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bootstrap = {
    schemaVersion: 1, projectId: 'example-mdc-project', secretId: 'mdc-runtime-config', secretVersion: '7',
    bootstrapCredentialFile: join(dir, 'bootstrap-key.json'), runtimeDirectory: join(dir, 'runtime'),
    runtimeServiceAccount: 'mdc-runtime@example-mdc-project.iam.gserviceaccount.com',
  };
  const payload = {
    schemaVersion: 1,
    environment: {
      MDC_APP_ORIGIN: 'https://context.example.com', MDC_GCP_PROJECT_ID: bootstrap.projectId,
      MDC_AUTH0_DOMAIN: 'example.eu.auth0.com', MDC_AUTH0_AUDIENCE: 'https://context.example.com/api',
      MDC_AUTH0_WEB_CLIENT_ID: 'web', MDC_AUTH0_NATIVE_CLIENT_ID: 'native',
      MDC_FIREBASE_API_KEY: 'fictional-browser-key', MDC_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
      MDC_STORAGE_BUCKET: 'example-mdc-project-attachments', MDC_HOST: '127.0.0.1', MDC_PORT: '8788',
    },
    serviceAccount: {
      type: 'service_account', project_id: bootstrap.projectId, client_email: bootstrap.runtimeServiceAccount,
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    },
  };
  const bootstrapFile = join(dir, 'bootstrap.json'), packageFile = join(dir, 'source-package.json');
  await writeFile(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
  await writeFile(packageFile, JSON.stringify(payload), { mode: 0o600 });
  await writeFile(bootstrap.bootstrapCredentialFile, JSON.stringify({ synthetic: true }), { mode: 0o600 });
  return { dir, bootstrap, payload, bootstrapFile, packageFile, localFile: join(bootstrap.runtimeDirectory, 'runtime-package.json') };
}

test('explicit cloud provisioning pins the request and persists a private identity-bound package', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await provisionRuntime(f.bootstrapFile, { source: 'cloud', execute: async (command, args, options) => {
    calls++;
    assert.equal(command, 'gcloud');
    assert.deepEqual(args, [
      `--credential-file-override=${f.bootstrap.bootstrapCredentialFile}`, '--quiet',
      'secrets', 'versions', 'access', '7', '--secret=mdc-runtime-config', '--project=example-mdc-project',
    ]);
    assert.deepEqual(Object.keys(options.env).sort(), ['CLOUDSDK_CONFIG', 'HOME', 'LANG', 'PATH']);
    assert.equal(options.env.CLOUDSDK_CONFIG, join(f.bootstrap.runtimeDirectory, 'gcloud'));
    return { stdout: JSON.stringify(f.payload) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { secretVersion: '7' });
  assert.equal((await stat(f.localFile)).mode & 0o777, 0o600);
  assert.equal((await stat(f.bootstrap.runtimeDirectory)).mode & 0o777, 0o700);
  const local = JSON.parse(await readFile(f.localFile, 'utf8'));
  assert.deepEqual(local.source, {
    projectId: f.bootstrap.projectId, secretId: f.bootstrap.secretId,
    secretVersion: '7', runtimeServiceAccount: f.bootstrap.runtimeServiceAccount,
  });
  assert.deepEqual(local.payload, f.payload);
  assert.deepEqual((await readdir(f.bootstrap.runtimeDirectory)).sort(), ['gcloud', 'runtime-package.json']);
});

test('a real application starts and restarts from local configuration with no bootstrap key or cloud CLI', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await provisionRuntime(f.bootstrapFile, { source: 'file', packageFile: f.packageFile });
  await rm(f.bootstrap.bootstrapCredentialFile);
  await mkdir(join(f.dir, 'apps/server/dist'), { recursive: true });
  await mkdir(join(f.dir, 'apps/web/dist'), { recursive: true });
  await writeFile(join(f.dir, 'apps/web/dist/index.html'), '<main>synthetic</main>');
  await writeFile(join(f.dir, 'apps/server/dist/index.js'), `
    const { createServer } = require('node:http');
    const { statSync } = require('node:fs');
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.MDC_GCP_PROJECT_ID !== 'example-mdc-project') process.exit(2);
    if ((statSync(process.env.GOOGLE_APPLICATION_CREDENTIALS).mode & 511) !== 384) process.exit(3);
    const server = createServer((_request, response) => response.end('local-runtime-ready'));
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  for (let restart = 0; restart < 2; restart++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { runRuntime } from ${JSON.stringify(join(source, 'start.mjs'))};
      process.exit(await runRuntime({ bootstrapFile: ${JSON.stringify(f.bootstrapFile)}, applicationRoot: ${JSON.stringify(f.dir)}, checkConfig: false }));
    `], { env: { PATH: '/nonexistent-cloud-cli' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '', stderr = '', exited = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const completion = once(child, 'exit');
    child.on('exit', () => { exited = true; });
    const deadline = performance.now() + 3000;
    while (!stdout.includes('\n') && !exited && performance.now() < deadline) await delay(20);
    assert.match(stdout, /^[0-9]+\n$/, `Local startup failed: ${stderr}`);
    const response = await fetch(`http://127.0.0.1:${stdout.trim()}/health/live`, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), 'local-runtime-ready');
    child.kill('SIGTERM');
    assert.deepEqual(await completion, [0, null]);
  }
});

test('denied retrieval and invalid packages leave the selected local package and key unchanged', async t => {
  const f = await fixture(t);
  await provisionRuntime(f.bootstrapFile, { source: 'file', packageFile: f.packageFile });
  await loadRuntime(f.bootstrapFile);
  const original = await readFile(f.localFile), keyPath = join(f.bootstrap.runtimeDirectory, 'runtime-key.json');
  const key = await readFile(keyPath);
  for (const execute of [
    async () => { throw new Error('PRIVATE_SENTINEL denied provider response'); },
    async () => ({ stdout: 'PRIVATE_SENTINEL not json' }),
    async () => ({ stdout: JSON.stringify({ ...f.payload, schemaVersion: 2 }) }),
  ]) {
    await assert.rejects(provisionRuntime(f.bootstrapFile, { source: 'cloud', execute }), error => {
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/); return true;
    });
    assert.deepEqual(await readFile(f.localFile), original);
    assert.deepEqual(await readFile(keyPath), key);
  }
});

test('startup refuses a mismatched pinned identity before projecting credentials and never falls back', async t => {
  const f = await fixture(t);
  await provisionRuntime(f.bootstrapFile, { source: 'file', packageFile: f.packageFile });
  for (const changed of [
    { secretVersion: '8' }, { secretId: 'other-runtime-package' }, { projectId: 'other-mdc-project' },
    { runtimeServiceAccount: 'other-runtime@example-mdc-project.iam.gserviceaccount.com' },
  ]) {
    const local = JSON.parse(await readFile(f.localFile, 'utf8'));
    Object.assign(local.source, changed);
    await writeFile(f.localFile, JSON.stringify(local));
    await assert.rejects(loadRuntime(f.bootstrapFile), /does not match pinned bootstrap/);
    await assert.rejects(stat(join(f.bootstrap.runtimeDirectory, 'runtime-key.json')), { code: 'ENOENT' });
    await provisionRuntime(f.bootstrapFile, { source: 'file', packageFile: f.packageFile });
  }
  await rm(f.localFile);
  await assert.rejects(loadRuntime(f.bootstrapFile), /private configuration/);
});

test('provisioning refuses unsafe destinations and local startup refuses unsafe package permissions', async t => {
  const f = await fixture(t);
  await provisionRuntime(f.bootstrapFile, { source: 'file', packageFile: f.packageFile });
  await chmod(f.localFile, 0o644);
  await assert.rejects(loadRuntime(f.bootstrapFile), /private configuration/);
  await assert.rejects(provisionRuntime(f.bootstrapFile, { source: 'file', packageFile: f.packageFile }), /Unsafe private configuration destination/);
  await rm(f.localFile);
  await symlink(f.packageFile, f.localFile);
  await assert.rejects(provisionRuntime(f.bootstrapFile, { source: 'file', packageFile: f.packageFile }), /Unsafe private configuration destination/);
  await assert.rejects(loadRuntime(f.bootstrapFile), /private configuration/);
});

test('provision CLI requires an explicit source and emits metadata only on import and cloud denial', async t => {
  const f = await fixture(t);
  const cli = join(source, 'provision.mjs');
  await assert.rejects(execute(process.execPath, [cli, f.bootstrapFile]), error => error.code === 1 && /Usage:/.test(error.stderr));
  const imported = await execute(process.execPath, [cli, f.bootstrapFile, '--from-file', f.packageFile]);
  assert.match(imported.stdout, /pinned version 7; mode 0600; no service restarted/);
  assert.doesNotMatch(imported.stdout + imported.stderr, /PRIVATE KEY|fictional-browser-key|client_email/);
  const bin = join(f.dir, 'bin');
  await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'gcloud'), '#!/bin/sh\nprintf "PRIVATE_SENTINEL denied raw stderr" >&2\nexit 1\n', { mode: 0o700 });
  await assert.rejects(execute(process.execPath, [cli, f.bootstrapFile, '--from-cloud'], { env: { PATH: bin } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Cannot retrieve pinned runtime package from Secret Manager/);
    assert.doesNotMatch(error.stdout + error.stderr, /PRIVATE_SENTINEL/);
    return true;
  });
});
