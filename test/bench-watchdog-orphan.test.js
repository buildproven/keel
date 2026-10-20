// REQ-BENCH-3: bench/swebench/test.sh's watchdog leaves nothing running that holds the caller's output open.
// A fake `docker` exits at once; a fake `sleep` ignores TERM, as a watchdog sleep does when the TERM lands between
// `sleep &` and `nap=$!`. Before the fix that orphan held the pipes for the whole 1800 s limit and CI hung.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmp, write } from './helpers.js';

const script = fileURLToPath(new URL('../bench/swebench/test.sh', import.meta.url));

const DEAF_SLEEP = `#!/bin/sh
echo $$ >> "$SLEEP_PIDS"
trap '' TERM
exec /bin/sleep "$1"
`;

test('REQ-BENCH-3 when test.sh exits, no watchdog sleep outlives it by more than a few seconds, even one that ignores TERM', async (t) => {
  const dir = tmp('keel-bench-');
  const pids = join(dir, 'sleep.pids');
  write(dir, {
    'fakebin/docker': '#!/bin/sh\nexit 0\n',
    'fakebin/sleep': DEAF_SLEEP,
    '.keel-bench/env': "REPO=sympy/sympy\nIMAGE=example/image:latest\nRUNNER='bin/test'\nBASE=HEAD\nTEST_RE=test_\n",
    'tests/test_x.py': '',
  });
  chmodSync(join(dir, 'fakebin/docker'), 0o755);
  chmodSync(join(dir, 'fakebin/sleep'), 0o755);
  copyFileSync(script, join(dir, '.keel-bench/test.sh'));
  t.after(() => {
    const left = existsSync(pids) ? readFileSync(pids, 'utf8').trim().split('\n') : [];
    for (const pid of left) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
  });
  const child = spawn('sh', ['.keel-bench/test.sh', 'tests/test_x.py'], {
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}`, SLEEP_PIDS: pids, KEEL_BENCH_TEST_TIMEOUT: '1800' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code })));
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), 10_000).unref());
  const t0 = Date.now();
  const result = await Promise.race([closed, timer]);
  assert.ok(result, `test.sh output stayed open ${Date.now() - t0} ms: a watchdog sleep outlived the script`);
  assert.equal(result.code, 0, output);
});
