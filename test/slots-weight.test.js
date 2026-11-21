// REQ-SLOT-4: a repo's gates weigh `gateCores` cores, and a fresh slot holds off the next for 30 s (BUI-2091).
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { CORES_PER_GATE, OPEN_HOLD_MS, idleSlots, newestSlotAgeMs, withGateSlot } from '../src/slots.js';
import { commit, fixtureRepo, tmp } from './helpers.js';

test('REQ-SLOT-4 idleSlots divides idle cores by the repo gate weight', () => {
  // 18 CPUs, all idle, no gate running: 9 slots at the default weight of 2, 2 at a weight of 8.
  assert.equal(CORES_PER_GATE, 2);
  assert.equal(idleSlots({ idle: 1, running: 0, cpus: 18, memLow: false }), 9);
  assert.equal(idleSlots({ idle: 1, running: 0, cpus: 18, memLow: false, coresPerGate: 8 }), 2);
  // One running at 50 % idle: 1 + floor(9 / 8) = 2.
  assert.equal(idleSlots({ idle: 0.5, running: 1, cpus: 18, memLow: false, coresPerGate: 8 }), 2);
  // The saturated-machine floor is unchanged.
  assert.equal(idleSlots({ idle: 0.1, running: 3, cpus: 18, memLow: false, coresPerGate: 8 }), 3);
});

function heldSlot(dir, i, mtimeMs) {
  const slot = join(dir, `slot-${i}`);
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, 'pid'), String(process.pid));
  utimesSync(slot, mtimeMs / 1000, mtimeMs / 1000);
  return slot;
}

test('REQ-SLOT-4 newestSlotAgeMs reads the newest held slot and is Infinity with none', () => {
  const dir = tmp();
  assert.equal(newestSlotAgeMs(join(dir, 'missing')), Infinity);
  assert.equal(newestSlotAgeMs(dir), Infinity);
  const now = 1_800_000_000_000;
  heldSlot(dir, 0, now - 50_000);
  heldSlot(dir, 1, now - 5_000);
  assert.equal(Math.round(newestSlotAgeMs(dir, now) / 1000), 5);
});

test('REQ-SLOT-4 within 30 s of a slot opening, a waiting gate opens no other, then opens one', () => {
  assert.equal(OPEN_HOLD_MS, 30_000);
  const dir = tmp();
  const t0 = 1_800_000_000_000;
  heldSlot(dir, 0, t0); // one gate running, its slot just opened
  let clock = t0 + 1_000;
  const said = [];
  let ran = false;
  withGateSlot(
    {
      dir,
      log: (l) => said.push(l),
      idle: () => 1, // the machine looks idle: without the hold, a second slot would open at once
      memLow: () => false,
      cpus: 18,
      now: () => clock,
      holdMs: OPEN_HOLD_MS,
      sleep: () => {
        clock += 10_000;
      },
    },
    () => {
      ran = true;
    },
  );
  assert.ok(ran);
  // It waited while the open slot was under 30 s old, and opened its own after.
  assert.match(said[0], /waiting for gate slot \(1 running of 1\)/);
  assert.ok(clock - t0 >= OPEN_HOLD_MS, `opened after ${clock - t0} ms`);
});

test('REQ-SLOT-4 keel.json gateCores is null by default and must be an integer of at least 1', () => {
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  assert.equal(loadConfig(dir, at({})).gateCores, null);
  assert.equal(loadConfig(dir, at({ gateCores: 8 })).gateCores, 8);
  for (const bad of [0, 1.5, '8'])
    assert.throws(() => loadConfig(dir, at({ gateCores: bad })), /"gateCores" must be null or an integer ≥ 1/);
});

test('REQ-SLOT-4 keel doctor prints the gate weight when keel.json sets gateCores', async () => {
  const { doctor } = await import('../src/doctor.js');
  const { fixtureConfig } = await import('./helpers.js');
  const { dir, base } = fixtureRepo();
  const weight = (cfg) => doctor({ repo: dir, base, config: fixtureConfig(cfg) }).find((r) => r.name === 'slots')?.output;
  assert.equal(
    weight({ checks: { test: 'true' }, testCommand: 'true', gateCores: 8 }),
    'gate weight: 8 cores (keel.json gateCores; default 2)',
  );
  assert.equal(weight({ checks: { test: 'true' }, testCommand: 'true' }), undefined, 'no line while the default applies');
});
