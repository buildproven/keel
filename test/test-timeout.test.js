import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// REQ-TRACE-6: with no per-test timeout, a hung test held CI until the job was cancelled at 20m16s and was never named
// (PR #33, run 39428969813, 2026-10-20).
const script = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test;
const words = script.split(/\s+/);

test('REQ-TRACE-6 the npm test script passes --test-timeout of at most 120000 ms', () => {
  const values = [...script.matchAll(/(?:^|\s)--test-timeout(?:=|\s+)(\S+)/g)].map((m) => m[1]);
  assert.equal(values.length, 1, `expected one --test-timeout in: ${script}`);
  assert.match(values[0], /^\d+$/, `--test-timeout must be a whole number of ms, got ${values[0]}`);
  const ms = Number(values[0]);
  assert.ok(ms > 0 && ms <= 120000, `--test-timeout must be 1..120000 ms, got ${ms}`);
});

// A timed-out test that left a handle open (a timer, a child, a socket) keeps its file's process alive, so the run
// still hangs after the timeout names it; --test-force-exit ends each file once its tests are done.
test('REQ-TRACE-6 the npm test script passes --test-force-exit so a timed-out test cannot hold its file open', () => {
  assert.ok(words.includes('--test-force-exit'), `expected --test-force-exit in: ${script}`);
});
