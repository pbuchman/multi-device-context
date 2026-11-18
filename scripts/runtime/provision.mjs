#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { provisionRuntime } from './package.mjs';

export async function runProvision(args = process.argv.slice(2)) {
  const [bootstrapFile, option, packageFile] = args;
  if (!bootstrapFile || !(option === '--from-cloud' && args.length === 2 || option === '--from-file' && packageFile && args.length === 3)) {
    throw new Error('usage');
  }
  const result = await provisionRuntime(resolve(bootstrapFile), {
    source: option === '--from-cloud' ? 'cloud' : 'file',
    ...(packageFile ? { packageFile: resolve(packageFile) } : {}),
  });
  console.log(`Local runtime package provisioned and validated; pinned version ${result.secretVersion}; mode 0600; no service restarted`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runProvision().catch(error => {
  // Never emit cloud stderr, raw JSON or credential-containing exceptions.
  if (error?.message === 'Cannot retrieve pinned runtime package from Secret Manager') console.error(error.message);
  else console.error('Runtime provisioning failed; verify protected files and pinned package. Usage: node scripts/runtime/provision.mjs BOOTSTRAP_JSON (--from-cloud | --from-file PRIVATE_PACKAGE_JSON)');
  process.exitCode = 1;
});
