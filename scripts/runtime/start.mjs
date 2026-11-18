#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { supervise } from './supervisor.mjs';
import { loadRuntime } from './package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function runRuntime({
  bootstrapFile = process.env.MDC_BOOTSTRAP_FILE, load = loadRuntime,
  applicationRoot = root, checkConfig = process.argv.includes('--check-config'),
  supervisorOptions = {},
} = {}) {
  if (!bootstrapFile) throw new Error('MDC_BOOTSTRAP_FILE must point to private configuration');
  const { environment } = await load(bootstrapFile);
  const server = join(applicationRoot, 'apps/server/dist/index.js');
  const webDist = join(applicationRoot, 'apps/web/dist');
  for (const file of [server, join(webDist, 'index.html')]) {
    if (!(await stat(file)).isFile()) throw new Error('Application build is incomplete');
  }
  environment.MDC_WEB_DIST = webDist;
  if (checkConfig) {
    console.log('Private runtime configuration and application build verified');
    return;
  }
  return supervise({
    command: process.execPath, args: [server], cwd: applicationRoot,
    environment, ...supervisorOptions,
  });
}

async function main() {
  return (await runRuntime()) ?? 0;
}

// PM2 fork mode imports its app with argv[1] still pointing at ProcessContainerFork.
// Its explicit app path distinguishes this entrypoint from ordinary library imports.
const entrypoints = [process.argv[1], process.env.pm_exec_path];
if (entrypoints.some(entry => entry && import.meta.url === pathToFileURL(entry).href)) main().then(code => {
  // PM2 owns a referenced IPC channel. exitCode alone leaves a launcher with
  // no application child alive, so complete the supervised lifetime explicitly.
  process.exit(code);
}).catch(error => {
  // Error objects from cloud clients may contain credentials; emit our bounded messages only.
  const safe = new Set([
    'MDC_BOOTSTRAP_FILE must point to private configuration', 'Invalid bootstrap configuration',
    'Cannot read private configuration: require an owned regular file with mode 0600',
    'Cannot retrieve pinned runtime package from Secret Manager', 'Runtime package is not JSON',
    'Invalid runtime package', 'Unsafe private runtime directory',
    'Local runtime package does not match pinned bootstrap configuration',
    'Unsafe private configuration destination',
    'Runtime credential destination is a symlink', 'Unsafe runtime credential destination',
    'Application build is incomplete',
  ]);
  const message = safe.has(error?.message) ? error.message : 'Runtime startup failed; verify private setup and application build';
  const deadline = setTimeout(() => process.exit(1), 1000);
  process.stderr.write(message + '\n', () => { clearTimeout(deadline); process.exit(1); });
});
