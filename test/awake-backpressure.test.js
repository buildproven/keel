import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WATCHDOG = realpathSync(fileURLToPath(new URL('../src/awake.js', import.meta.url)));
const BYTES = 8 * 1024 * 1024;

/** Run the watchdog with a reader that stops reading for `pauseMs` at the start, as a busy caller does. */
function slowRead(command, pauseMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WATCHDOG, '30000', '/bin/sh', '-c', command], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    p.stdin.end();
    const got = { 1: 0, 2: 0, note: '' };
    p.stdout.pause();
    p.stderr.pause();
    setTimeout(() => {
      p.stdout.on('data', (c) => (got[1] += c.length));
      p.stderr.on('data', (c) => (got[2] += c.length));
      p.stdout.resume();
      p.stderr.resume();
    }, pauseMs);
    p.stdio[3].on('data', (c) => (got.note += c));
    p.on('error', reject);
    p.on('close', (code, signal) => resolve({ ...got, code, signal }));
  });
}

test('REQ-GATE-67 output written while the caller is not reading is all delivered, not a crash', async () => {
  const r = await slowRead(`head -c ${BYTES} /dev/zero; head -c ${BYTES} /dev/zero >&2`, 500);
  assert.deepEqual([r.code, r.signal, r[1], r[2]], [0, null, BYTES, BYTES], r.note);
  assert.match(r.note, /"exit":\{"code":0,"signal":null\}/);
});
