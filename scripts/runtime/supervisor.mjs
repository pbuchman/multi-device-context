import { spawn } from 'node:child_process';

const RECOVERY_EXIT_CODE = 75;
const logRecovery = event => process.stderr.write(JSON.stringify(event) + '\n');

/** Retain only the already validated app environment. Recovery never calls the
 * bootstrap loader or Secret Manager and never starts a second live child. */
export function supervise({
  command, args = [], cwd, environment, signals = process, spawnChild = spawn,
  clock = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  log = logRecovery,
}) {
  const retainedEnvironment = Object.freeze({ ...environment });
  return new Promise(resolve => {
    let child, timer, stopTimer, stopping = false, finished = false, failures = 0;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimer(timer); clearTimer(stopTimer);
      signals.removeListener('SIGTERM', terminate);
      signals.removeListener('SIGINT', interrupt);
      resolve(code);
    };
    const stop = signal => {
      if (stopping || finished) return;
      stopping = true;
      clearTimer(timer);
      if (!child) { finish(0); return; }
      // Application shutdown is bounded independently; also cover a child that
      // cannot process operator signals at all.
      stopTimer = setTimer(() => { try { child?.kill('SIGKILL'); } catch { /* Ownership remains until exit. */ } }, 15_000);
      try { child.kill(signal); } catch { /* Ownership remains until exit. */ }
    };
    const terminate = () => stop('SIGTERM');
    const interrupt = () => stop('SIGINT');
    signals.on('SIGTERM', terminate);
    signals.on('SIGINT', interrupt);
    const start = () => {
      if (stopping || finished) return;
      const started = clock();
      let settled = false;
      const exited = (code, signal, spawnError = false) => {
        if (settled || finished) return;
        settled = true;
        child = undefined;
        const durationMs = Math.max(0, Math.round(clock() - started));
        if (stopping) { finish(0); return; }
        if (spawnError || code !== RECOVERY_EXIT_CODE) {
          if (spawnError) log({ operation: 'child-recovery', outcome: 'failed', durationMs, reason: 'spawn-error' });
          finish(code ?? 1); return;
        }
        if (durationMs >= 300_000) failures = 0;
        const delayMs = Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000);
        log({ operation: 'child-recovery', outcome: 'scheduled', durationMs, reason: 'io-timeout', delayMs });
        timer = setTimer(start, delayMs);
      };
      try {
        child = spawnChild(command, args, { cwd, env: { ...retainedEnvironment }, stdio: 'inherit' });
        const ownedChild = child;
        child.on('error', () => {
          // 'error' may report a failed signal to an otherwise live process.
          // Only a missing PID proves spawn never created a child.
          if (!ownedChild.pid) { exited(1, null, true); return; }
          if (!finished) log({ operation: 'child-recovery', outcome: 'failed', durationMs: Math.max(0, Math.round(clock() - started)), reason: 'child-error' });
        });
        child.once('exit', (code, signal) => exited(code, signal));
      } catch { exited(1, null, true); }
    };
    start();
  });
}
