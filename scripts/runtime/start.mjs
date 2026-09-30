#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function main() {
  if (!process.env.MDC_BOOTSTRAP_FILE) throw new Error('MDC_BOOTSTRAP_FILE must point to private configuration');
  const { environment } = await loadRuntime(process.env.MDC_BOOTSTRAP_FILE);
  const server = join(root, 'apps/server/dist/index.js');
  const webDist = join(root, 'apps/web/dist');
  for (const file of [server, join(webDist, 'index.html')]) {
    if (!(await stat(file)).isFile()) throw new Error('Application build is incomplete');
  }
  environment.MDC_WEB_DIST = webDist;
  if (process.argv.includes('--check-config')) {
    console.log('Private runtime configuration and application build verified');
    return;
  }
  const child = spawn(process.execPath, [server], { cwd: root, env: environment, stdio: 'inherit' });
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  child.on('error', () => { console.error('Cannot start application process'); process.exitCode = 1; });
  child.on('exit', code => {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
    process.exitCode = code ?? 1;
  });
}

main().catch(error => {
  // Error objects from cloud clients may contain credentials; emit our bounded messages only.
  const safe = new Set([
    'MDC_BOOTSTRAP_FILE must point to private configuration', 'Invalid bootstrap configuration',
    'Cannot read private configuration: require an owned regular file with mode 0600',
    'Cannot retrieve pinned runtime package from Secret Manager', 'Runtime package is not JSON',
    'Invalid runtime package', 'Unsafe private runtime directory',
    'Runtime credential destination is a symlink', 'Unsafe runtime credential destination',
    'Application build is incomplete',
  ]);
  console.error(safe.has(error?.message) ? error.message : 'Runtime startup failed; verify private setup and application build');
  process.exitCode = 1;
});
