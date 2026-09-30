import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory, parseBootstrap, parseRuntimePackage, readPrivateJSON, writeRuntimeCredential } from './config.mjs';

const run = promisify(execFile);

export async function loadRuntime(bootstrapFile) {
  const bootstrap = parseBootstrap(await readPrivateJSON(bootstrapFile));
  await readPrivateJSON(bootstrap.bootstrapCredentialFile);
  await ensurePrivateDirectory(bootstrap.runtimeDirectory);
  const cliConfig = join(bootstrap.runtimeDirectory, 'gcloud');
  await ensurePrivateDirectory(cliConfig);
  const baseEnvironment = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? dirname(bootstrap.runtimeDirectory),
    LANG: 'C.UTF-8',
  };
  let stdout;
  try {
    ({ stdout } = await run('gcloud', [
      `--credential-file-override=${bootstrap.bootstrapCredentialFile}`, '--quiet',
      'secrets', 'versions', 'access', bootstrap.secretVersion,
      `--secret=${bootstrap.secretId}`, `--project=${bootstrap.projectId}`,
    ], {
      env: { ...baseEnvironment, CLOUDSDK_CONFIG: cliConfig },
      timeout: 60000, maxBuffer: 262144,
    }));
  } catch { throw new Error('Cannot retrieve pinned runtime package from Secret Manager'); }
  let candidate;
  try { candidate = JSON.parse(stdout); } catch { throw new Error('Runtime package is not JSON'); }
  const payload = parseRuntimePackage(candidate, bootstrap);
  const credential = await writeRuntimeCredential(bootstrap, payload.serviceAccount);
  return {
    bootstrap,
    environment: {
      ...baseEnvironment, ...payload.environment, NODE_ENV: 'production',
      GOOGLE_APPLICATION_CREDENTIALS: credential,
    },
  };
}
