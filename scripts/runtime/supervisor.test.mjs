import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { supervise } from './supervisor.mjs';

class Child extends EventEmitter {
  kills = [];
  kill(signal) { this.kills.push(signal); return true; }
}
function harness(supervise) {
  const signals = new EventEmitter(), children = [], scheduled = [], logs = [];
  let now = 0;
  const completion = supervise({
    command: process.execPath, args: ['server.js'], cwd: '/example',
    environment: { GOOGLE_APPLICATION_CREDENTIALS: '/private/retained-key.json', MDC_PORT: '8788' },
    signals, clock: () => now, log: event => logs.push(event),
    spawnChild: (_command, _args, options) => { const child = new Child(); child.environment = options.env; children.push(child); return child; },
    setTimer: (callback, delay) => { const timer = { callback, delay, cancelled: false }; scheduled.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cancelled = true; },
  });
  return { completion, signals, children, scheduled, logs, advance: ms => { now += ms; } };
}
test('backs off watchdog-only recovery 1, 2, 4, 8, 16, 30 seconds, capped; resets at five minutes', async () => {
  const h = harness(supervise);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    h.children.at(-1).emit('exit', 75, null);
    const timer = h.scheduled.at(-1);
    assert.equal(timer.delay, delay);
    h.advance(delay); timer.callback();
  }
  h.advance(300_000);
  h.children.at(-1).emit('exit', 75, null);
  assert.equal(h.scheduled.at(-1).delay, 1000);
  for (const child of h.children) assert.deepEqual(child.environment, h.children[0].environment);
  h.signals.emit('SIGTERM');
  assert.equal(await h.completion, 0);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
});
test('ordinary child failure returns to PM2 without retained-env respawn', async () => {
  const h = harness(supervise);
  h.children[0].emit('exit', 1, null);
  assert.equal(await h.completion, 1);
  assert.equal(h.children.length, 1);
  assert.equal(h.scheduled.length, 0);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} cancels a scheduled recovery and wins the child exit race`, async () => {
      const h = harness(supervise);
    h.children[0].emit('exit', 75, null);
    const timer = h.scheduled.at(-1);
    h.signals.emit(signal);
    assert.equal(await h.completion, 0);
    assert.equal(timer.cancelled, true);
    timer.callback(); // A callback already dequeued before cancellation must also be safe.
    assert.equal(h.children.length, 1);
    const running = harness(supervise);
    running.signals.emit(signal);
    assert.deepEqual(running.children[0].kills, [signal]);
    running.children[0].emit('exit', 75, null);
    assert.equal(await running.completion, 0);
    assert.equal(running.children.length, 1);
  });
}
test('spawn errors are bounded and do not leak raw errors into diagnostics', async () => {
  const h = harness(supervise);
  h.children[0].emit('error', new Error('PRIVATE_SENTINEL'));
  assert.equal(await h.completion, 1);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_SENTINEL'), false);
});

test('an error from an existing child retains ownership until the exit event', async () => {
  const h = harness(supervise);
  h.children[0].pid = 12345;
  h.children[0].emit('error', new Error('PRIVATE_KILL_ERROR'));
  assert.equal(await Promise.race([h.completion, Promise.resolve('still-owned')]), 'still-owned');
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.children.length, 1);
  h.children[0].emit('exit', 75, null);
  assert.equal(h.scheduled.at(-1).delay, 1000);
  h.signals.emit('SIGTERM');
  assert.equal(await h.completion, 0);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_KILL_ERROR'), false);
});
