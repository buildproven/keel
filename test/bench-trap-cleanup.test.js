// REQ-BENCH-2: the trap's cleanup in bench/swebench/test.sh always finishes (BUI-1705).
// 1. Its cleanup commands ran under `set -e`: when `docker rm -f` failed, the handler ended there with docker's status,
//    before it killed the client and before `exit 143`, so the client lived on.
// 2. It removed the container only once more after the client was gone. A client killed after it sent its create
//    request leaves the daemon to finish it, so the container could appear after test.sh had exited.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmp, write } from './helpers.js';

const script = fileURLToPath(new URL('../bench/swebench/test.sh', import.meta.url));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};

// State files: .created (container exists), .removed (container removed), .run.pid (client pid).
// `run` is a client that has created its container: it ignores TERM (sig-proxy), sends TERM to test.sh, and hangs.
// `rm` fails the first time (a daemon error) and works after that.
const FAKE_DOCKER_RM_FAILS = `#!/bin/sh
log="$FAKE_DOCKER_LOG"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  run)
    exec >/dev/null 2>&1
    echo $$ > "$log.run.pid"
    trap '' TERM
    touch "$log.created"
    kill -TERM "$PPID"
    exec /bin/sleep 60 ;;
  rm)
    if [ ! -f "$log.rmfailed" ]; then touch "$log.rmfailed"; echo "Error response from daemon: busy" >&2; exit 1; fi
    touch "$log.removed"; exit 0 ;;
  container)
    [ -f "$log.created" ] && [ ! -f "$log.removed" ] ;;
  *) exit 0 ;;
esac
`;

// `run` is a client that has sent its create request: it ignores TERM, sends TERM to test.sh, and hangs. A detached
// "daemon" finishes the create 1 s after the client is gone.
const FAKE_DOCKER_LATE_CREATE = `#!/bin/sh
log="$FAKE_DOCKER_LOG"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  run)
    exec >/dev/null 2>&1
    echo $$ > "$log.run.pid"
    client=$$
    (
      trap '' TERM INT HUP
      while kill -0 "$client" 2>/dev/null; do /bin/sleep 0.1; done
      /bin/sleep 1
      touch "$log.created"
    ) </dev/null >/dev/null 2>&1 &
    trap '' TERM
    kill -TERM "$PPID"
    exec /bin/sleep 60 ;;
  rm)
    [ -f "$log.created" ] && [ ! -f "$log.removed" ] || { echo "Error: No such container: $3" >&2; exit 1; }
    touch "$log.removed"; exit 0 ;;
  container)
    [ -f "$log.created" ] && [ ! -f "$log.removed" ] ;;
  *) exit 0 ;;
esac
`;

async function runScript(t, fakeDocker) {
  const dir = tmp('keel-bench-');
  const log = join(dir, 'docker.log');
  write(dir, {
    'fakebin/docker': fakeDocker,
    '.keel-bench/env': "REPO=sympy/sympy\nIMAGE=example/image:latest\nRUNNER='bin/test'\nBASE=HEAD\nTEST_RE=test_\n",
    'tests/test_x.py': '',
  });
  chmodSync(join(dir, 'fakebin/docker'), 0o755);
  copyFileSync(script, join(dir, '.keel-bench/test.sh'));
  t.after(() => {
    if (!existsSync(`${log}.run.pid`)) return;
    const pid = Number(readFileSync(`${log}.run.pid`, 'utf8'));
    if (alive(pid)) process.kill(pid, 'SIGKILL');
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
  const ms = Date.now() - t0;
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim() : '');
  return { log, code, signal, ms, output, calls };
}

test('REQ-BENCH-2 a failing docker rm in the trap still kills the client and exits 143', async (t) => {
  const r = await runScript(t, FAKE_DOCKER_RM_FAILS);
  assert.ok(r.ms < 30_000, `took ${r.ms} ms`);
  assert.equal(r.code, 143, `exit ${r.code} ${r.signal}, want 143:\n${r.calls()}\n${r.output}`);
  const pid = Number(readFileSync(`${r.log}.run.pid`, 'utf8'));
  assert.ok(!alive(pid), `the docker client (pid ${pid}) is still running:\n${r.calls()}\n${r.output}`);
  assert.ok(existsSync(`${r.log}.removed`), `the container was never removed:\n${r.calls()}\n${r.output}`);
  assert.match(r.output, /could not remove container keel-bench-/, `the failed removal was not reported:\n${r.output}`);
});

test('REQ-BENCH-2 a container the daemon creates after the client is killed is still removed', async (t) => {
  const r = await runScript(t, FAKE_DOCKER_LATE_CREATE);
  assert.ok(r.ms < 30_000, `took ${r.ms} ms`);
  assert.equal(r.code, 143, `exit ${r.code} ${r.signal}, want 143:\n${r.calls()}\n${r.output}`);
  // Give the fake daemon time to finish its late create if test.sh exited before it.
  for (let i = 0; i < 40 && !existsSync(`${r.log}.created`); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(existsSync(`${r.log}.created`), `the fake daemon never created the container:\n${r.calls()}`);
  assert.ok(existsSync(`${r.log}.removed`), `the late-created container was left behind:\n${r.calls()}\n${r.output}`);
});

// `rm` fails because `--rm` removed the container first: the container is gone, so the trap reports no failure and
// does not wait out its grace period for a late create.
const FAKE_DOCKER_AUTOREMOVED = `#!/bin/sh
log="$FAKE_DOCKER_LOG"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  run)
    exec >/dev/null 2>&1
    echo $$ > "$log.run.pid"
    trap '' TERM
    touch "$log.created"
    kill -TERM "$PPID"
    exec /bin/sleep 60 ;;
  rm)
    touch "$log.removed"; echo "Error: No such container: $3" >&2; exit 1 ;;
  container)
    [ -f "$log.created" ] && [ ! -f "$log.removed" ] ;;
  *) exit 0 ;;
esac
`;

test('REQ-BENCH-2 a docker rm that fails on a container already gone counts as removed', async (t) => {
  const r = await runScript(t, FAKE_DOCKER_AUTOREMOVED);
  assert.equal(r.code, 143, `exit ${r.code} ${r.signal}, want 143:\n${r.calls()}\n${r.output}`);
  assert.doesNotMatch(r.output, /could not remove/, `a removed container was reported as not removed:\n${r.output}`);
  const rms = r
    .calls()
    .split('\n')
    .filter((l) => l.startsWith('rm ')).length;
  assert.equal(rms, 1, `want one docker rm, got ${rms}:\n${r.calls()}`);
});
