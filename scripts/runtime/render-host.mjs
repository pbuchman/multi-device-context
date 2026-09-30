#!/usr/bin/env node
import { writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { userInfo } from 'node:os';
import { ensurePrivateDirectory } from './config.mjs';
import { loadRuntime } from './package.mjs';
import { renderHostConfig } from './host-config.mjs';

try {
  const [bootstrapFile, deployment, outputDirectory] = process.argv.slice(2);
  if (!bootstrapFile || !deployment || !outputDirectory || process.argv.length !== 5) {
    throw new Error('usage');
  }
  const { bootstrap, environment } = await loadRuntime(resolve(bootstrapFile));
  const target = resolve(deployment);
  for (const file of ['apps/server/dist/index.js', 'apps/web/dist/index.html', 'node_modules/pm2/bin/pm2-runtime']) {
    if (!(await stat(join(target, file))).isFile()) throw new Error('build');
  }
  const rendered = renderHostConfig({
    bootstrapFile: resolve(bootstrapFile), deployment: target, node: process.execPath,
    user: userInfo().username, runtimeDirectory: bootstrap.runtimeDirectory,
    appOrigin: environment.MDC_APP_ORIGIN, port: environment.MDC_PORT,
  });
  const output = resolve(outputDirectory);
  await ensurePrivateDirectory(output);
  await writeFile(join(output, 'multi-device-context.service'), rendered.unit, { mode: 0o600, flag: 'wx' });
  await writeFile(join(output, 'multi-device-context.caddy'), rendered.caddy, { mode: 0o600, flag: 'wx' });
  console.log('Host configuration prepared for review; no host service changed');
} catch {
  console.error('Cannot render host configuration. Usage: node scripts/runtime/render-host.mjs BOOTSTRAP_JSON BUILT_DEPLOYMENT EMPTY_PRIVATE_OUTPUT_DIRECTORY');
  process.exitCode = 1;
}
