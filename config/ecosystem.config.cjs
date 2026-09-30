const path = require('node:path');

if (!process.env.MDC_BOOTSTRAP_FILE || !process.env.PM2_HOME) {
  throw new Error('MDC_BOOTSTRAP_FILE and a dedicated PM2_HOME are required');
}

module.exports = {
  apps: [{
    name: 'multi-device-context',
    cwd: path.resolve(__dirname, '..'),
    script: 'scripts/runtime/start.mjs',
    interpreter: process.execPath,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    exp_backoff_restart_delay: 1000,
    kill_timeout: 30000,
    time: true,
    out_file: path.join(process.env.PM2_HOME, 'application-out.log'),
    error_file: path.join(process.env.PM2_HOME, 'application-error.log'),
    env: { NODE_ENV: 'production', MDC_BOOTSTRAP_FILE: process.env.MDC_BOOTSTRAP_FILE },
  }],
};
