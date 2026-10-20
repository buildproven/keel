// REQ-BENCH-1/2: bench/swebench/test.sh never leaves a container running after its test run (BUI-1323).
// A fake `docker` on PATH records its arguments; no real container is started or stopped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmp, write } from './helpers.js';

const script = fileURLToPath(new URL('../bench/swebench/test.sh', import.meta.url));

// `run` records its args and its pid, then either exits 0 or sleeps FAKE_RUN_SECONDS; `kill`/`stop`/`rm`
// record the call and end the recorded `run` process, as the real daemon ends a killed container's client.
const FAKE_DOCKER = `#!/bin/sh
log="$FAKE_DOCKER_LOG"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  run)
    echo $$ > "$log.run.pid"
    [ -n "\${FAKE_RUN_SECONDS:-}" ] || exit 0
    sleep "$FAKE_RUN_SECONDS" &
    child=$!
    trap 'kill $child 2>/dev/null; exit 137' TERM
    wait $child
    exit 0 ;;
  kill|stop|rm)
    [ -f "$log.run.pid" ] && kill "$(cat "$log.run.pid")" 2>/dev/null
    exit 0 ;;
esac
exit 0
`;

function fixture() {
  const dir = tmp('keel-bench-');
  const bin = join(dir, 'fakebin');
  write(dir, {
    'fakebin/docker': FAKE_DOCKER,
    '.keel-bench/env': "REPO=sympy/sympy\nIMAGE=example/image:latest\nRUNNER='bin/test -C --verbose'\nBASE=HEAD\nTEST_RE=test_\n",
    'tests/test_x.py': '',
  });
  chmodSync(join(bin, 'docker'), 0o755);
  copyFileSync(script, join(dir, '.keel-bench/test.sh'));
  return { dir, bin, log: join(dir, 'docker.log') };
}

function start({ dir, bin, log }, env) {
  const child = spawn('sh', ['.keel-bench/test.sh', 'tests/test_x.py'], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, output })));
  return { child, done };
}

const calls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
const nameOf = (runLine) => runLine.match(/--name (\S+)/)?.[1];
const waitFor = async (pred, ms) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
};

test('REQ-BENCH-1 test.sh names the container and runs its command under the KEEL_BENCH_TEST_TIMEOUT limit', async () => {
  const f = fixture();
  const { code, output } = await start(f, { KEEL_BENCH_TEST_TIMEOUT: '77' }).done;
  assert.equal(code, 0, output);
  const run = calls(f.log).find((l) => l.startsWith('run '));
  assert.ok(run, `no docker run call: ${calls(f.log)}`);
  assert.match(nameOf(run) ?? '', /^keel-bench-\d+-\d+$/, run);
  assert.match(run, /timeout 77 /, run);
  assert.match(run, /bin\/test -C --verbose tests\/test_x\.py/, run);
});

test('REQ-BENCH-1 the default limit is 1800 s and a bad KEEL_BENCH_TEST_TIMEOUT is an error', async () => {
  const f = fixture();
  const ok = await start(f, { KEEL_BENCH_TEST_TIMEOUT: '' }).done;
  assert.equal(ok.code, 0, ok.output);
  assert.match(
    calls(f.log).find((l) => l.startsWith('run ')),
    /timeout 1800 /,
  );
  const g = fixture();
  const bad = await start(g, { KEEL_BENCH_TEST_TIMEOUT: '10m' }).done;
  assert.equal(bad.code, 2, bad.output);
  assert.match(bad.output, /KEEL_BENCH_TEST_TIMEOUT/);
  assert.deepEqual(calls(g.log), []);
});

test('REQ-BENCH-1 when the container outlives the limit, test.sh kills it by name and exits non-zero', async () => {
  const f = fixture();
  const t0 = Date.now();
  const { code, output } = await start(f, { KEEL_BENCH_TEST_TIMEOUT: '1', FAKE_RUN_SECONDS: '60' }).done;
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
  assert.notEqual(code, 0, output);
  assert.match(output, /exceeded 1 s/);
  const name = nameOf(calls(f.log).find((l) => l.startsWith('run ')));
  assert.ok(name, calls(f.log).join('\n'));
  assert.ok(
    calls(f.log).some((l) => /^(kill|stop|rm -f) /.test(l) && l.endsWith(` ${name}`)),
    calls(f.log).join('\n'),
  );
});

test('REQ-BENCH-2 when the process that ran test.sh is terminated, the container it started is killed', async () => {
  const f = fixture();
  const { child, done } = start(f, { KEEL_BENCH_TEST_TIMEOUT: '600', FAKE_RUN_SECONDS: '60' });
  assert.ok(await waitFor(() => existsSync(`${f.log}.run.pid`), 10_000), 'docker run never started');
  const t0 = Date.now();
  child.kill('SIGTERM');
  const { code, signal } = await done;
  assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`);
  assert.ok(code !== 0 || signal, `exit ${code} ${signal}`);
  const name = nameOf(calls(f.log).find((l) => l.startsWith('run ')));
  assert.ok(
    calls(f.log).some((l) => /^(kill|stop|rm -f) /.test(l) && l.endsWith(` ${name}`)),
    calls(f.log).join('\n'),
  );
});

// A watchdog `sleep` that misses its TERM (the signal lands between `sleep &` and `nap=$!`) must not outlive the
// script and hold the caller's output pipes open: before the fix a 1800 s default made this test hang in CI.
const DEAF_SLEEP = `#!/bin/sh
echo $$ >> "$FAKE_DOCKER_LOG.sleep.pids"
trap '' TERM
exec /bin/sleep "$1"
`;

test('REQ-BENCH-3 when test.sh exits, no watchdog sleep outlives it by more than a few seconds, even one that ignores TERM', async (t) => {
  const f = fixture();
  write(f.dir, { 'fakebin/sleep': DEAF_SLEEP });
  chmodSync(join(f.bin, 'sleep'), 0o755);
  t.after(() => {
    for (const pid of calls(`${f.log}.sleep.pids`)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
  });
  const t0 = Date.now();
  const timer = new Promise((r) => setTimeout(() => r(null), 10_000).unref());
  const result = await Promise.race([start(f, { KEEL_BENCH_TEST_TIMEOUT: '1800' }).done, timer]);
  assert.ok(result, `test.sh output stayed open ${Date.now() - t0} ms: a watchdog sleep outlived the script`);
  assert.equal(result.code, 0, result.output);
});
