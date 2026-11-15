// REQ-BENCH-2: a signal while the container is created but not yet started still leaves no container (BUI-1704).
// The fake `docker run` models the real client in its startup window: once the container exists, the client forwards
// TERM to it instead of exiting (sig-proxy), `docker kill` fails because the container is not running yet, and the
// client then starts the container. Before the fix the trap sent TERM to the client and ran `docker kill`, which failed
// under `set -e`, so the script exited and the client started a container that nothing stopped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmp, write } from './helpers.js';

const script = fileURLToPath(new URL('../bench/swebench/test.sh', import.meta.url));

// State files: .created (container exists), .running (container started), .removed (container removed).
const FAKE_DOCKER = `#!/bin/sh
log="$FAKE_DOCKER_LOG"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  run)
    exec >/dev/null 2>&1
    echo $$ > "$log.run.pid"
    trap '' TERM
    touch "$log.created"
    kill -TERM "$PPID"
    /bin/sleep 1
    [ -f "$log.removed" ] && exit 125
    touch "$log.running"
    exec /bin/sleep 60 ;;
  kill)
    if [ -f "$log.running" ] && [ ! -f "$log.removed" ]; then
      touch "$log.removed"; kill -KILL "$(cat "$log.run.pid")"; exit 0
    fi
    echo "Error response from daemon: container $2 is not running" >&2; exit 1 ;;
  rm)
    [ -f "$log.created" ] && [ ! -f "$log.removed" ] || { echo "Error: No such container: $3" >&2; exit 1; }
    touch "$log.removed"
    [ -f "$log.running" ] && kill -KILL "$(cat "$log.run.pid")"
    exit 0 ;;
  container)
    [ -f "$log.created" ] && [ ! -f "$log.removed" ] ;;
  *) exit 0 ;;
esac
`;

test('REQ-BENCH-2 a TERM while the container is created but not started leaves no container running', async (t) => {
  const dir = tmp('keel-bench-');
  const log = join(dir, 'docker.log');
  write(dir, {
    'fakebin/docker': FAKE_DOCKER,
    '.keel-bench/env': "REPO=sympy/sympy\nIMAGE=example/image:latest\nRUNNER='bin/test'\nBASE=HEAD\nTEST_RE=test_\n",
    'tests/test_x.py': '',
  });
  chmodSync(join(dir, 'fakebin/docker'), 0o755);
  copyFileSync(script, join(dir, '.keel-bench/test.sh'));
  t.after(() => {
    if (!existsSync(`${log}.run.pid`)) return;
    try {
      process.kill(Number(readFileSync(`${log}.run.pid`, 'utf8')), 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  });
  const child = spawn('sh', ['.keel-bench/test.sh', 'tests/test_x.py'], {
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, KEEL_BENCH_TEST_TIMEOUT: '600' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const t0 = Date.now();
  const { code, signal } = await new Promise((resolve) => child.on('close', (c, s) => resolve({ code: c, signal: s })));
  assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`);
  assert.ok(code !== 0 || signal, `exit ${code} ${signal}: ${output}`);
  // Give a surviving client time to pass its 1 s create→start step.
  await new Promise((r) => setTimeout(r, 2_000));
  const calls = readFileSync(log, 'utf8').trim();
  const orphan = existsSync(`${log}.running`) && !existsSync(`${log}.removed`);
  assert.ok(!orphan, `the container started after test.sh exited and nothing stopped it:\n${calls}\n${output}`);
  assert.ok(existsSync(`${log}.removed`), `the created container was never removed:\n${calls}\n${output}`);
});
