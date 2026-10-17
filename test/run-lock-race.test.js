import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmp } from './helpers.js';

const RUN = new URL('../src/run-lock.js', import.meta.url).href;

// Try for the lock (retrying the locked error with a short random wait), hold it for 20 ms, release it, and print the
// time window it was held in.
const CHILD = `
import { acquireRunLock } from '${RUN}';
const lock = process.argv[1];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 400; i++) {
  try {
    const release = acquireRunLock(lock);
    const start = performance.timeOrigin + performance.now();
    pause(20);
    const end = performance.timeOrigin + performance.now();
    release();
    console.log(JSON.stringify({ held: true, start, end }));
    process.exit(0);
  } catch (e) {
    if (!/locked by another keel run/.test(e.message)) {
      console.log(JSON.stringify({ held: false, error: e.message }));
      process.exit(0);
    }
    pause(1 + Math.random() * 10);
  }
}
console.log(JSON.stringify({ held: false, error: 'never got the lock' }));
`;

const contender = (lock) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, lock], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => done(JSON.parse(out)));
  });

test('REQ-RUN-10 runs contending for one card lock never hold it at the same time, and each gets it in turn', async () => {
  for (let round = 0; round < 6; round++) {
    const lock = join(tmp('keel-locks-'), 'repo-abc12345-T-1');
    const results = await Promise.all(Array.from({ length: 6 }, () => contender(lock)));
    for (const r of results) assert.equal(r.held, true, `round ${round}: ${r.error}`);
    const windows = results.map((r) => [r.start, r.end]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < windows.length; i++)
      assert.ok(windows[i][0] >= windows[i - 1][1], `round ${round}: two runs held the lock at once`);
  }
});
