import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withGateSlot } from '../src/slots.js';
import { tmp } from './helpers.js';

const hold = (dir, i, pid) => {
  mkdirSync(join(dir, `slot-${i}`), { recursive: true });
  writeFileSync(join(dir, `slot-${i}`, 'pid'), String(pid));
};

// BUI-2122: the Mac panicked (watchdog timeout, 39 swap files) when a gate started its browsers with memory short.
test('REQ-SLOT-1 a lone gate waits while memory is short, says so, and runs once memory frees', () => {
  const dir = tmp('keel-locks-');
  const said = [];
  let short = true;
  let waits = 0;
  const ran = withGateSlot(
    {
      dir,
      sleep: () => {
        waits++;
        short = false; // another app freed memory
      },
      log: (l) => said.push(l),
      memLow: () => short,
      idle: () => 1,
      cpus: 8,
    },
    () => 'ran',
  );
  assert.equal(ran, 'ran');
  assert.equal(waits, 1, 'it waited one poll for memory');
  assert.deepEqual(said, ['waiting for memory: under 15 % available or the kernel reports pressure']);
});

test('REQ-SLOT-1 a lone gate still runs under heavy outside CPU load when memory is fine', () => {
  const dir = tmp('keel-locks-');
  const ran = withGateSlot(
    { dir, sleep: () => assert.fail('must not wait'), log: () => {}, memLow: () => false, idle: () => 0, cpus: 8 },
    () => 'ran',
  );
  assert.equal(ran, 'ran');
});

// BUI-2121: KEEL_GATE_SLOTS=2 copied into every command turned the load limit off.
test('REQ-SLOT-1 KEEL_GATE_SLOTS caps the measured count and never raises it', () => {
  const dir = tmp('keel-locks-');
  const other = spawn('sleep', ['30']);
  try {
    hold(dir, 0, other.pid);
    const said = [];
    let waits = 0;
    // One gate runs; memory is short, so the measured count is that one gate: a cap of 4 must not open a second slot.
    const ran = withGateSlot(
      {
        dir,
        cap: 4,
        sleep: () => {
          waits++;
        },
        log: (l) => said.push(l),
        memLow: () => waits < 1,
        idle: () => 1,
        cpus: 8,
      },
      () => 'ran',
    );
    assert.equal(ran, 'ran');
    assert.ok(waits >= 1, 'with memory short it waited instead of taking a second slot');
    assert.equal(said[0], 'waiting for gate slot (1 running of 1)');
  } finally {
    other.kill('SIGKILL');
  }
});

test('REQ-SLOT-1 KEEL_GATE_SLOTS lowers the measured count', () => {
  const dir = tmp('keel-locks-');
  const other = spawn('sleep', ['30']);
  try {
    hold(dir, 0, other.pid);
    const said = [];
    let waits = 0;
    // An idle 8-core machine measures 4 slots; a cap of 1 keeps the second gate waiting.
    withGateSlot(
      {
        dir,
        cap: 1,
        sleep: () => {
          waits++;
          rmSync(join(dir, 'slot-0'), { recursive: true }); // the other gate's stage ends
        },
        log: (l) => said.push(l),
        memLow: () => false,
        idle: () => 1,
        cpus: 8,
      },
      () => 'ran',
    );
    assert.equal(waits, 1, 'the cap of 1 held the second gate until the first freed its slot');
    assert.equal(said[0], 'waiting for gate slot (1 running of 1)');
  } finally {
    other.kill('SIGKILL');
  }
});
