import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

const environmentKeys = [
  'MDC_APP_ORIGIN', 'MDC_AUTH0_DOMAIN', 'MDC_AUTH0_AUDIENCE', 'MDC_AUTH0_WEB_CLIENT_ID',
  'MDC_AUTH0_NATIVE_CLIENT_ID', 'MDC_FIREBASE_API_KEY', 'MDC_FIREBASE_AUTH_DOMAIN',
  'MDC_GCP_PROJECT_ID', 'MDC_STORAGE_BUCKET', 'MDC_HOST', 'MDC_PORT',
];
const bootstrapKeys = ['schemaVersion', 'projectId', 'secretId', 'secretVersion',
  'bootstrapCredentialFile', 'runtimeDirectory', 'runtimeServiceAccount'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000\r\n]/u.test(value);
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

export function parseBootstrap(value) {
  if (!exactKeys(value, bootstrapKeys) || value.schemaVersion !== 1 ||
      typeof value.projectId !== 'string' || !projectPattern.test(value.projectId) ||
      typeof value.secretId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/u.test(value.secretId) ||
      typeof value.secretVersion !== 'string' || !/^[1-9][0-9]*$/u.test(value.secretVersion) ||
      !text(value.bootstrapCredentialFile) || !isAbsolute(value.bootstrapCredentialFile) || resolve(value.bootstrapCredentialFile) !== value.bootstrapCredentialFile ||
      !text(value.runtimeDirectory) || !isAbsolute(value.runtimeDirectory) || resolve(value.runtimeDirectory) !== value.runtimeDirectory ||
      !text(value.runtimeServiceAccount) ||
      !value.runtimeServiceAccount.endsWith(`@${value.projectId}.iam.gserviceaccount.com`)) {
    throw new Error('Invalid bootstrap configuration');
  }
  return value;
}

export function parseRuntimePackage(value, bootstrap) {
  const fail = () => { throw new Error('Invalid runtime package'); };
  if (!exactKeys(value, ['schemaVersion', 'environment', 'serviceAccount']) || value.schemaVersion !== 1 ||
      !object(value.environment) || !environmentKeys.every(k => text(value.environment[k])) ||
      !Object.keys(value.environment).every(k => [...environmentKeys, 'MDC_OPENROUTER_API_KEY', 'MDC_TITLE_MODEL', 'MDC_AI_EXISTING_OWNER_UID'].includes(k) && text(value.environment[k]))) fail();
  const e = value.environment;
  let origin;
  try { origin = new URL(e.MDC_APP_ORIGIN); } catch { fail(); }
  if (origin.protocol !== 'https:' || origin.origin !== e.MDC_APP_ORIGIN || origin.username || origin.password ||
      !hostPattern.test(e.MDC_AUTH0_DOMAIN) || !hostPattern.test(e.MDC_FIREBASE_AUTH_DOMAIN) ||
      e.MDC_GCP_PROJECT_ID !== bootstrap.projectId || e.MDC_HOST !== '127.0.0.1' ||
      !/^[1-9][0-9]{0,4}$/u.test(e.MDC_PORT) || Number(e.MDC_PORT) > 65535) fail();
  const account = value.serviceAccount;
  if (!object(account) || account.type !== 'service_account' || account.project_id !== bootstrap.projectId ||
      account.client_email !== bootstrap.runtimeServiceAccount || typeof account.private_key !== 'string') fail();
  try {
    if (createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') fail();
  } catch { fail(); }
  return value;
}

const sourceIdentity = bootstrap => Object.fromEntries(
  ['projectId', 'secretId', 'secretVersion', 'runtimeServiceAccount'].map(key => [key, bootstrap[key]]),
);

export function localRuntimePackage(bootstrap, payload) {
  return { schemaVersion: 1, source: sourceIdentity(bootstrap), payload: parseRuntimePackage(payload, bootstrap) };
}

export function parseLocalRuntimePackage(value, bootstrap) {
  const expected = sourceIdentity(bootstrap);
  if (!exactKeys(value, ['schemaVersion', 'source', 'payload']) || value.schemaVersion !== 1 ||
      !exactKeys(value.source, Object.keys(expected)) ||
      !Object.keys(expected).every(key => value.source[key] === expected[key])) {
    throw new Error('Local runtime package does not match pinned bootstrap configuration');
  }
  return parseRuntimePackage(value.payload, bootstrap);
}

// O_NOFOLLOW protects the leaf. Inspect parent components too, so a private
// file cannot silently be selected through a directory symlink.
async function checkParents(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new Error('unsafe');
  let parent = parse(path).root;
  for (const component of dirname(path).slice(parent.length).split('/').filter(Boolean)) {
    parent = join(parent, component);
    const info = await inspect(parent);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe');
  }
}

const owned = info => !process.getuid || info.uid === process.getuid();
const privateFile = info => info.isFile() && info.nlink === 1 && (info.mode & 0o777) === 0o600 && owned(info);

export async function readPrivateJSON(path) {
  let file;
  try {
    await checkParents(path);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!privateFile(info) || info.size > 262144) throw new Error('unsafe');
    return JSON.parse(await file.readFile('utf8'));
  } catch { throw new Error('Cannot read private configuration: require an owned regular file with mode 0600'); }
  finally { await file?.close(); }
}

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function checkPrivateDirectory(path) {
  try {
    await checkParents(path);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || !owned(info)) throw new Error('unsafe');
  } catch { throw new Error('Unsafe private runtime directory'); }
}

export async function ensurePrivateDirectory(path) {
  try {
    await checkParents(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch { throw new Error('Unsafe private runtime directory'); }
  await checkPrivateDirectory(path);
}

export async function writePrivateJSON(target, value) {
  await ensurePrivateDirectory(dirname(target));
  const existing = await inspect(target);
  if (existing && !privateFile(existing)) throw new Error('Unsafe private configuration destination');
  const temporary = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, target);
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return target;
}

export async function writeRuntimeCredential(bootstrap, account) {
  await ensurePrivateDirectory(bootstrap.runtimeDirectory);
  const target = join(bootstrap.runtimeDirectory, 'runtime-key.json');
  const existing = await inspect(target);
  if (existing?.isSymbolicLink()) throw new Error('Runtime credential destination is a symlink');
  if (existing && !privateFile(existing)) throw new Error('Unsafe runtime credential destination');
  return writePrivateJSON(target, account);
}
