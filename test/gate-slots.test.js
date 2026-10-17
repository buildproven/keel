import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { fixedSlots, slotsInUse, withGateSlot } from '../src/slots.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const hold = (dir, i, pid) => {
  mkdirSync(join(dir, `slot-${i}`), { recursive: true });
  writeFileSync(join(dir, `slot-${i}`, 'pid'), String(pid));
};

test('REQ-GATE-29 a gate waits for a free slot, says so, and frees its slot after the stage', () => {
  const dir = tmp('keel-locks-');
  const other = spawn('sleep', ['30']);
  hold(dir, 0, other.pid);
  const said = [];
  let waits = 0;
  const sleep = () => {
    waits++;
    rmSync(join(dir, 'slot-0'), { recursive: true }); // the other gate's stage ends
  };
  const got = withGateSlot({ dir, size: 1, sleep, log: (l) => said.push(l) }, () => slotsInUse(dir));
  other.kill();
  assert.equal(waits, 1);
  assert.deepEqual(said, ['waiting for gate slot (1 running of 1)']);
  assert.equal(got, 1, 'the slot is held while the stage runs');
  assert.equal(slotsInUse(dir), 0, 'and freed after it');
});

test('REQ-GATE-29 a slot whose process is gone is taken over without waiting', () => {
  const dir = tmp('keel-locks-');
  hold(dir, 0, 2 ** 22 + 12345); // no such process
  const ran = withGateSlot({ dir, size: 1, sleep: () => assert.fail('must not wait'), log: () => {} }, () => 'ran');
  assert.equal(ran, 'ran');
});

test('REQ-GATE-29 KEEL_GATE_SLOTS fixes the slot count; unset, the count follows the load (REQ-SLOT-1)', () => {
  assert.equal(fixedSlots({}), null);
  assert.equal(fixedSlots({ KEEL_GATE_SLOTS: '3' }), 3);
  assert.throws(() => fixedSlots({ KEEL_GATE_SLOTS: 'x' }), /KEEL_GATE_SLOTS/);
});

test('REQ-GATE-29 a gate with a slot dir runs its heavy stages in a slot and leaves none held', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  const slotDir = tmp('keel-locks-');
  const r = gate({ repo: dir, base, card: parseCard('# T-1: t\nkind: bug\nsize: S\n'), config: fixtureConfig(), slotDir });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.ok(existsSync(slotDir));
  assert.deepEqual(readdirSync(slotDir), []);
});
