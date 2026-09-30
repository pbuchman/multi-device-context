import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, stat, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBootstrap, parseRuntimePackage, readPrivateJSON, writeRuntimeCredential } from './config.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const bootstrap = {
  schemaVersion: 1, projectId: 'example-mdc-project', secretId: 'mdc-runtime-config',
  secretVersion: '7', bootstrapCredentialFile: '/private/bootstrap-key.json',
  runtimeDirectory: '/private/mdc-runtime',
  runtimeServiceAccount: 'mdc-home-runtime@example-mdc-project.iam.gserviceaccount.com',
};
const payload = () => ({
  schemaVersion: 1,
  environment: {
    MDC_APP_ORIGIN: 'https://context.example.com', MDC_GCP_PROJECT_ID: bootstrap.projectId,
    MDC_AUTH0_DOMAIN: 'example.eu.auth0.com', MDC_AUTH0_AUDIENCE: 'https://context.example.com/api',
    MDC_AUTH0_WEB_CLIENT_ID: 'web', MDC_AUTH0_NATIVE_CLIENT_ID: 'native',
    MDC_FIREBASE_API_KEY: 'public-browser-key', MDC_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
    MDC_STORAGE_BUCKET: 'example-mdc-project-attachments', MDC_HOST: '127.0.0.1', MDC_PORT: '8788',
  },
  serviceAccount: {
    type: 'service_account', project_id: bootstrap.projectId,
    client_email: bootstrap.runtimeServiceAccount,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  },
});

test('private config reads reject broad permissions and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdc-private-read-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(bootstrap), { mode: 0o600 });
    assert.deepEqual(await readPrivateJSON(path), bootstrap);
    await chmod(path, 0o644);
    await assert.rejects(readPrivateJSON(path), /private configuration/);
    await chmod(path, 0o600);
    await symlink(path, join(dir, 'alias.json'));
    await assert.rejects(readPrivateJSON(join(dir, 'alias.json')), /private configuration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('requires a pinned positive version and absolute private paths', () => {
  assert.deepEqual(parseBootstrap(bootstrap), bootstrap);
  for (const secretVersion of ['latest', '0', '-1', '../7']) {
    assert.throws(() => parseBootstrap({ ...bootstrap, secretVersion }), /bootstrap/i);
  }
  assert.throws(() => parseBootstrap({ ...bootstrap, runtimeDirectory: './private' }), /bootstrap/i);
  assert.throws(() => parseBootstrap({ ...bootstrap, extra: 'x' }), /bootstrap/i);
});

test('accepts only declared app environment and matching runtime identity', () => {
  assert.equal(parseRuntimePackage(payload(), bootstrap).environment.MDC_PORT, '8788');
  for (const field of ['NODE_OPTIONS', 'GOOGLE_APPLICATION_CREDENTIALS', 'AUTH0_API_TOKEN']) {
    const p = payload(); p.environment[field] = 'injected';
    assert.throws(() => parseRuntimePackage(p, bootstrap), /package/i);
  }
  const p = payload(); p.serviceAccount.client_email = 'other@example.iam.gserviceaccount.com';
  assert.throws(() => parseRuntimePackage(p, bootstrap), /package/i);
  const q = payload(); q.environment.MDC_GCP_PROJECT_ID = 'other-project';
  assert.throws(() => parseRuntimePackage(q, bootstrap), /package/i);
});

test('rejects non-loopback binding, malformed origins and invalid key without echoing contents', () => {
  for (const [key, value] of [['MDC_HOST', '0.0.0.0'], ['MDC_PORT', '70000'], ['MDC_APP_ORIGIN', 'http://example.com']]) {
    const p = payload(); p.environment[key] = value;
    assert.throws(() => parseRuntimePackage(p, bootstrap), /package/i);
  }
  const p = payload(); p.serviceAccount.private_key = 'PRIVATE_SENTINEL';
  assert.throws(() => parseRuntimePackage(p, bootstrap), e => /package/i.test(e.message) && !e.message.includes('PRIVATE_SENTINEL'));
});

test('projects the runtime key privately and refuses symlink destinations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mdc-runtime-test-'));
  try {
    const b = { ...bootstrap, runtimeDirectory: join(dir, 'private') };
    const path = await writeRuntimeCredential(b, payload().serviceAccount);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(b.runtimeDirectory)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).client_email, b.runtimeServiceAccount);
    const rotated = await writeRuntimeCredential({ ...b, secretVersion: '8' }, {
      ...payload().serviceAccount, private_key_id: 'new-key-version',
    });
    assert.equal(rotated, path, 'rotation must replace the same private path');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).private_key_id, 'new-key-version');
    await rm(path); await symlink(join(dir, 'not-a-key'), path);
    await assert.rejects(writeRuntimeCredential(b, payload().serviceAccount), /symlink/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
