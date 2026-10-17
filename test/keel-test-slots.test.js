import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { fixedSlots, idleSlots, withGateSlot } from '../src/slots.js';
import { FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const BIN = resolve('bin/keel.js');

/** A slot held by this live process, as another gate's would be. */
function held(dir, i) {
  mkdirSync(join(dir, `slot-${i}`), { recursive: true });
  writeFileSync(join(dir, `slot-${i}`, 'pid'), String(process.pid));
}

/** A live process that is not our child, as another gate is. */
const orphan = (sec) => Number(execFileSync('sh', ['-c', `sleep ${sec} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim());

test('REQ-SLOT-1 the slot count follows idle CPU: running gates plus one per 2 idle cores, at most half the cores', () => {
  assert.equal(idleSlots({ idle: 1, running: 0, cpus: 8, memLow: false }), 4, 'idle: half the cores');
  assert.equal(idleSlots({ idle: 0.05, running: 2, cpus: 8, memLow: false }), 2, 'saturated: no new slot');
  assert.equal(idleSlots({ idle: 0.05, running: 0, cpus: 8, memLow: false }), 1, 'saturated with none running: one');
  assert.equal(idleSlots({ idle: 0.45, running: 1, cpus: 8, memLow: false }), 2, '3.6 idle cores open one more slot');
  assert.equal(idleSlots({ idle: 0.9, running: 1, cpus: 8, memLow: true }), 1, 'short of memory: no new slot');
  assert.equal(idleSlots({ idle: 1, running: 0, cpus: 1, memLow: false }), 1);
});

test('REQ-SLOT-1 KEEL_GATE_SLOTS fixes the count; a bad value is an error', () => {
  assert.equal(fixedSlots({}), null);
  assert.equal(fixedSlots({ KEEL_GATE_SLOTS: '3' }), 3);
  assert.throws(() => fixedSlots({ KEEL_GATE_SLOTS: 'x' }), /KEEL_GATE_SLOTS must be an integer ≥ 1/);
});

test('REQ-SLOT-1 a waiting gate recomputes the count: a free slot opens when the CPU frees up, and the line is said again when it changes', () => {
  const dir = tmp('keel-locks-');
  held(dir, 0);
  const idles = [0.1, 0.1, 0.9];
  const said = [];
  let waits = 0;
  const ran = withGateSlot(
    { dir, sleep: () => waits++, log: (l) => said.push(l), idle: () => idles.shift(), memLow: () => false, cpus: 8 },
    () => 'ran',
  );
  assert.equal(ran, 'ran');
  assert.equal(waits, 2);
  assert.deepEqual(said, ['waiting for gate slot (1 running of 1)'], 'the same line is said once');
  const dir2 = tmp('keel-locks-');
  held(dir2, 0);
  held(dir2, 1);
  const idles2 = [0.1, 0.1, 0.9];
  const said2 = [];
  let freed = false;
  const release = () => {
    if (!freed) rmSync(join(dir2, 'slot-1'), { recursive: true });
    freed = true;
  };
  withGateSlot(
    { dir: dir2, sleep: release, log: (l) => said2.push(l), idle: () => idles2.shift(), memLow: () => false, cpus: 8 },
    () => 'ran',
  );
  assert.deepEqual(
    said2,
    ['waiting for gate slot (2 running of 2)', 'waiting for gate slot (1 running of 1)'],
    'said again when it changes',
  );
});

test('REQ-SLOT-1 with no slot held, a gate runs however busy the machine is', () => {
  const dir = tmp('keel-locks-');
  const ran = withGateSlot(
    { dir, sleep: () => assert.fail('must not wait'), log: () => {}, idle: () => 0, memLow: () => true, cpus: 4 },
    () => 'ran',
  );
  assert.equal(ran, 'ran');
});

test('REQ-SLOT-3 a ticket sorts by the gate start time, so a started gate is ahead of gates that came after it', () => {
  const dir = tmp('keel-locks-');
  const other = orphan(30);
  writeFileSync(join(dir, `ticket-${String(Date.now() - 5000).padStart(15, '0')}-${other}`), '');
  const ran = withGateSlot(
    { dir, size: 1, since: Date.now() - 10000, sleep: () => assert.fail('an older gate never waits for a newer one'), log: () => {} },
    () => 'ran',
  );
  process.kill(other);
  assert.equal(ran, 'ran');
});

test('REQ-SLOT-3 every heavy stage of one gate queues at the gate start time, not behind gates that arrived during its first stage', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  const slotDir = tmp('keel-locks-');
  mkdirSync(slotDir, { recursive: true });
  const other = orphan(8);
  // A gate that asked 1 s after this one starts; this gate's first stage takes over 2 s.
  writeFileSync(join(slotDir, `ticket-${String(Date.now() + 1000).padStart(15, '0')}-${other}`), '');
  const said = [];
  process.env.KEEL_GATE_SLOTS = '1';
  try {
    const config = fixtureConfig({ checks: { test: `sleep 2 && ${FIXTURE_TEST}` } });
    const r = gate({ repo: dir, base, card: parseCard('# T-1: t\nkind: bug\nsize: S\n'), config, slotDir, log: (l) => said.push(l) });
    assert.equal(r.pass, true, JSON.stringify(r.results));
  } finally {
    delete process.env.KEEL_GATE_SLOTS;
    process.kill(other);
  }
  assert.deepEqual(
    said.filter((l) => l.startsWith('waiting')),
    [],
  );
});

test('REQ-SLOT-2 keel test runs the test command in a gate slot and exits with its exit code', () => {
  const { dir } = fixtureRepo();
  const probe =
    "node -e \"const fs=require('fs');console.log('slots:'+fs.readdirSync(process.env.KEEL_STATE_DIR+'/locks').filter(f=>f.startsWith('slot-')).join(','));process.exit(4)\"";
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: probe }, testCommand: probe }) }, 'chore: cfg');
  const state = tmp('keel-state-');
  const r = spawnSync(process.execPath, [BIN, 'test', '--repo', dir], {
    encoding: 'utf8',
    env: { ...process.env, KEEL_STATE_DIR: state, KEEL_GATE_SLOTS: '1' },
  });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stdout, /^slots:slot-0$/m, 'the test ran while holding the slot');
  const after = spawnSync('ls', [join(state, 'locks')], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(after, /slot-0/, 'the slot is freed after the run');
});

test('REQ-SLOT-2 keel test takes no argument', () => {
  const r = spawnSync(process.execPath, [BIN, 'test', 'extra'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /test takes no argument/);
});
