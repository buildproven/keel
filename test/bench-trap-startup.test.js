// REQ-BENCH-2: bench/swebench/test.sh handles TERM/INT/HUP from before it starts the container (BUI-1704).
// Before the fix the trap was set only after `docker run &` and the watchdog start, so a signal in that window ended
// the script with the default action and left the new container running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmp, write } from './helpers.js';

const script = fileURLToPath(new URL('../bench/swebench/test.sh', import.meta.url));

// The script's commands, without comment lines and with continuation lines joined to their command.
const commands = () =>
  readFileSync(script, 'utf8')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l));

test('REQ-BENCH-2 test.sh sets its TERM/INT/HUP trap before it starts the container or the watchdog', () => {
  const lines = commands();
  const trap = lines.findIndex((l) => /^\s*trap '.*' TERM INT HUP\s*$/.test(l));
  const run = lines.findIndex((l) => /^\s*docker run /.test(l));
  const watchdog = lines.findIndex((l) => /^\s*\(\s*$/.test(l));
  assert.ok(trap >= 0 && run >= 0 && watchdog >= 0, `trap ${trap}, docker run ${run}, watchdog ${watchdog}`);
  assert.ok(trap < run, `trap (command ${trap}) is set after docker run (command ${run})`);
  assert.ok(trap < watchdog, `trap (command ${trap}) is set after the watchdog start (command ${watchdog})`);
});

// `run` records its pid, sends TERM to the script that started it at once (the earliest moment a signal can find a
// started container), then hangs like a stuck container until `kill`/`stop`/`rm` ends it or it gets TERM itself.
const FAKE_DOCKER = `#!/bin/sh
log="$FAKE_DOCKER_LOG"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  run)
    echo $$ > "$log.run.pid"
    sleep 60 &
    child=$!
    trap 'kill $child 2>/dev/null; exit 137' TERM
    kill -TERM "$PPID"
    wait $child
    exit 0 ;;
  kill|stop|rm)
    [ -f "$log.run.pid" ] && kill "$(cat "$log.run.pid")" 2>/dev/null
    exit 0 ;;
esac
exit 0
`;

test('REQ-BENCH-2 a TERM that arrives as the container starts still kills it by name, and test.sh exits non-zero', async (t) => {
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
  assert.doesNotMatch(output, /parameter not set|unbound variable/, output);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  const name = calls.find((l) => l.startsWith('run '))?.match(/--name (\S+)/)?.[1];
  assert.ok(name, calls.join('\n'));
  assert.ok(
    calls.some((l) => /^(kill|stop|rm -f) /.test(l) && l.endsWith(` ${name}`)),
    `container ${name} was not killed:\n${calls.join('\n')}\n${output}`,
  );
});
