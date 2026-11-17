import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awakeMs, spawnAwake, tickFor } from '../src/awake.js';
import { sh } from '../src/git.js';
import { runWorker } from '../src/workers.js';

// The process that keeps the time ($PPID of the command) is stopped for 2 s, as a sleeping Mac stops it, while the
// command goes on; then the command runs 0.3 s more. 2.3 s of wall time, about 0.4 s of it awake.
const SUSPENDED = 'w=$PPID; kill -STOP $w; sleep 2; kill -CONT $w; sleep 0.3; echo ok';
const config = { workerTimeoutSec: 1, workerEnvAllow: [] };

test('REQ-GATE-67 a gate command is not killed for time its timekeeper was suspended', () => {
  const r = sh(SUSPENDED, process.cwd(), { timeoutSec: 1 });
  assert.equal(r.timedOut, false, r.out);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), 'ok');
});

test('REQ-GATE-67 a worker is not killed for time its timekeeper was suspended', () => {
  const r = runWorker({ provider: 'exec', command: ['/bin/sh', '-c', SUSPENDED] }, 'prompt', process.cwd(), config);
  assert.equal(r.status, 'ok', r.output);
  assert.equal(r.text.trim(), 'ok');
});

test('REQ-GATE-67 a gate command that runs past its awake time is still killed with SIGTERM', () => {
  const start = Date.now();
  const r = sh('exec sleep 10', process.cwd(), { timeoutSec: 1 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.equal(r.signal, 'SIGTERM');
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start} ms`);
});

test('REQ-GATE-67 a worker that runs past workerTimeoutSec is still a timeout', () => {
  const r = runWorker({ provider: 'exec', command: ['sleep', '10'] }, '', process.cwd(), config);
  assert.equal(r.status, 'timeout');
});

test('REQ-GATE-67 exit codes, signals, output, and stdin pass through the watchdog unchanged', () => {
  assert.deepEqual(
    [sh('echo out; echo err >&2; exit 3', process.cwd())].map((r) => [r.code, r.signal, r.timedOut, r.out]),
    [[3, null, false, 'out\nerr\n']],
  );
  for (const signal of ['SIGTERM', 'SIGPIPE', 'SIGKILL']) {
    const r = sh(`kill -${signal.slice(3)} $$`, process.cwd());
    assert.deepEqual([r.code, r.signal, r.timedOut], [null, signal, false], signal);
  }
  const cat = spawnAwake('cat', [], { input: 'from stdin', encoding: 'utf8' }, 5000);
  assert.deepEqual([cat.status, cat.stdout, cat.error], [0, 'from stdin', undefined]);
});

test('REQ-GATE-67 a worker command that cannot start is a spawn error, as before', () => {
  const r = runWorker({ provider: 'exec', command: ['/nonexistent/keel-worker'] }, '', process.cwd(), config);
  assert.equal(r.status, 'spawn-error: spawnSync /nonexistent/keel-worker ENOENT');
});

test('REQ-GATE-67 output over maxBuffer stops the command, not only the watchdog', () => {
  const start = Date.now();
  const r = spawnAwake('/bin/sh', ['-c', 'head -c 100000 /dev/zero; exec sleep 20'], { maxBuffer: 1024 }, 60_000);
  assert.equal(r.error?.code, 'ENOBUFS');
  assert.ok(Date.now() - start < 10_000, `took ${Date.now() - start} ms`);
});

test('REQ-GATE-67 a tick gap over ten ticks counts as one tick; the tick is 1/20 of the timeout, 20 ms to 1 s', () => {
  assert.equal(awakeMs(1000, 1000), 1000);
  assert.equal(awakeMs(10_000, 1000), 10_000);
  assert.equal(awakeMs(6 * 3600_000, 1000), 1000);
  assert.deepEqual([tickFor(900_000), tickFor(2000), tickFor(100)], [1000, 100, 20]);
  assert.throws(() => spawnAwake('true', [], {}, 0), /positive/);
  assert.throws(() => sh(5, process.cwd()), TypeError);
});
