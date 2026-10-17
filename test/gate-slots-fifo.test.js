import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withGateSlot } from '../src/slots.js';
import { tmp } from './helpers.js';

/** A live process that is not our child, as another gate is (a zombie child would look alive after it exits). */
const orphan = () => Number(execFileSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());

test('REQ-GATE-29 a free slot goes to the gate that asked first: a newer gate waits behind an older live ticket', () => {
  const dir = tmp('keel-locks-');
  const other = orphan();
  const older = join(dir, `ticket-${String(Date.now() - 5000).padStart(15, '0')}-${other}`);
  writeFileSync(older, '');
  const said = [];
  let waits = 0;
  const sleep = () => {
    waits++;
    rmSync(older); // the older gate got its slot
  };
  const ran = withGateSlot({ dir, size: 1, sleep, log: (l) => said.push(l) }, () => 'ran');
  process.kill(other);
  assert.equal(ran, 'ran');
  assert.equal(waits, 1, 'waited for the older gate');
  assert.match(said[0], /waiting for gate slot \(0 running of 1, 1 ahead\)/);
  assert.deepEqual(readdirSync(dir), [], 'no ticket or slot left behind');
});

test('REQ-GATE-29 a ticket whose gate is gone does not hold the queue', () => {
  const dir = tmp('keel-locks-');
  writeFileSync(join(dir, `ticket-${String(Date.now() - 5000).padStart(15, '0')}-${2 ** 22 + 12345}`), '');
  const ran = withGateSlot({ dir, size: 1, sleep: () => assert.fail('must not wait'), log: () => {} }, () => 'ran');
  assert.equal(ran, 'ran');
  assert.deepEqual(readdirSync(dir), []);
});
