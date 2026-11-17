import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnAwake } from '../src/awake.js';
import { sh } from '../src/git.js';
import { runWorker } from '../src/workers.js';

// A process left behind holds the command's stdout and stderr for 8 s; the timeout is 1 s.
const elapsed = (start) => Date.now() - start;

test('REQ-GATE-67 a timed-out command returns at its timeout although a child it started still holds its output', () => {
  const start = Date.now();
  const r = sh('echo before; sleep 8 & sleep 8', process.cwd(), { timeoutSec: 1 });
  assert.ok(elapsed(start) < 5000, `took ${elapsed(start)} ms`);
  assert.deepEqual([r.timedOut, r.code, r.signal, r.out], [true, null, 'SIGTERM', 'before\n']);
});

test('REQ-GATE-67 a command that exits but leaves a process holding its output returns at its timeout', () => {
  const start = Date.now();
  const r = sh('(sleep 8 &); echo hi', process.cwd(), { timeoutSec: 1 });
  assert.ok(elapsed(start) < 5000, `took ${elapsed(start)} ms`);
  assert.deepEqual([r.timedOut, r.code, r.out], [true, 0, 'hi\n']);
});

test('REQ-GATE-67 a hung worker whose child holds its output is a timeout, not a hang', () => {
  const start = Date.now();
  const r = runWorker({ provider: 'exec', command: ['/bin/sh', '-c', 'sleep 8 & sleep 8'] }, 'prompt', process.cwd(), {
    workerTimeoutSec: 1,
    workerEnvAllow: [],
  });
  assert.ok(elapsed(start) < 5000, `took ${elapsed(start)} ms`);
  assert.equal(r.status, 'timeout');
});

test('REQ-GATE-67 output over maxBuffer returns although a child of the command holds its output', () => {
  const start = Date.now();
  const r = spawnAwake('/bin/sh', ['-c', 'head -c 100000 /dev/zero; sleep 8 & sleep 8'], { maxBuffer: 1024 }, 60_000);
  assert.equal(r.error?.code, 'ENOBUFS');
  assert.ok(elapsed(start) < 5000, `took ${elapsed(start)} ms`);
});

test('REQ-GATE-67 a large stdin a child never reads, and large output, pass through the watchdog', () => {
  const big = 'x'.repeat(4 * 1024 * 1024);
  const echo = spawnAwake('cat', [], { input: big, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, 30_000);
  assert.deepEqual([echo.status, echo.stdout.length, echo.error], [0, big.length, undefined]);
  const early = spawnAwake('/bin/sh', ['-c', 'echo early >&2; exit 1'], { input: big, encoding: 'utf8' }, 30_000);
  assert.deepEqual([early.status, early.stderr], [1, 'early\n']);
});
