import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import {
  checkPrivateDirectory, ensurePrivateDirectory, localRuntimePackage, parseBootstrap,
  parseLocalRuntimePackage, parseRuntimePackage, readPrivateJSON, writePrivateJSON, writeRuntimeCredential,
} from './config.mjs';

const run = promisify(execFile);
const packagePath = bootstrap => join(bootstrap.runtimeDirectory, 'runtime-package.json');
const baseEnvironment = bootstrap => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env.HOME ?? dirname(bootstrap.runtimeDirectory),
  LANG: 'C.UTF-8',
});

async function retrievePinnedPackage(bootstrap, execute) {
  await readPrivateJSON(bootstrap.bootstrapCredentialFile);
  await ensurePrivateDirectory(bootstrap.runtimeDirectory);
  const cliConfig = join(bootstrap.runtimeDirectory, 'gcloud');
  await ensurePrivateDirectory(cliConfig);
  let stdout;
  try {
    ({ stdout } = await execute('gcloud', [
      `--credential-file-override=${bootstrap.bootstrapCredentialFile}`, '--quiet',
      'secrets', 'versions', 'access', bootstrap.secretVersion,
      `--secret=${bootstrap.secretId}`, `--project=${bootstrap.projectId}`,
    ], {
      env: { ...baseEnvironment(bootstrap), CLOUDSDK_CONFIG: cliConfig },
      timeout: 60000, maxBuffer: 262144,
    }));
  } catch { throw new Error('Cannot retrieve pinned runtime package from Secret Manager'); }
  let candidate;
  try { candidate = JSON.parse(stdout); } catch { throw new Error('Runtime package is not JSON'); }
  return parseRuntimePackage(candidate, bootstrap);
}

/** Explicit provisioning only. A denied/invalid retrieval never selects or
 * replaces an older package. A local import is a separately selected operation. */
export async function provisionRuntime(bootstrapFile, { source, packageFile, execute = run } = {}) {
  if (!['cloud', 'file'].includes(source) || (source === 'file' ? !packageFile : packageFile !== undefined)) {
    throw new Error('Select exactly one runtime package provisioning source');
  }
  const bootstrap = parseBootstrap(await readPrivateJSON(bootstrapFile));
  const payload = source === 'cloud'
    ? await retrievePinnedPackage(bootstrap, execute)
    : parseRuntimePackage(await readPrivateJSON(packageFile), bootstrap);
  await writePrivateJSON(packagePath(bootstrap), localRuntimePackage(bootstrap, payload));
  return { secretVersion: bootstrap.secretVersion };
}

/** Startup deliberately has no cloud branch and never reads the bootstrap key. */
export async function loadRuntime(bootstrapFile) {
  const bootstrap = parseBootstrap(await readPrivateJSON(bootstrapFile));
  await checkPrivateDirectory(bootstrap.runtimeDirectory);
  const payload = parseLocalRuntimePackage(await readPrivateJSON(packagePath(bootstrap)), bootstrap);
  const credential = await writeRuntimeCredential(bootstrap, payload.serviceAccount);
  return {
    bootstrap,
    environment: {
      ...baseEnvironment(bootstrap), ...payload.environment, NODE_ENV: 'production',
      GOOGLE_APPLICATION_CREDENTIALS: credential,
    },
  };
}
