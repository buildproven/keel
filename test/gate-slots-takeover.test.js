import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reclaim, slotsInUse, withGateSlot } from '../src/slots.js';
import { tmp } from './helpers.js';

const hold = (dir, i, pid) => {
  mkdirSync(join(dir, `slot-${i}`), { recursive: true });
  writeFileSync(join(dir, `slot-${i}`, 'pid'), String(pid));
};
const deadPid = () => spawnSync('true').pid;

test('REQ-GATE-29 a gate that saw a slot dead removes it only if it is still dead when it takes it over', () => {
  const dir = tmp('keel-locks-');
  const other = spawn('sleep', ['30']);
  try {
    // Another gate took the dead slot over between this gate's look and its removal: the slot is live again.
    hold(dir, 0, other.pid);
    assert.equal(reclaim(join(dir, 'slot-0')), false);
    assert.equal(readFileSync(join(dir, 'slot-0', 'pid'), 'utf8'), String(other.pid));
    hold(dir, 1, deadPid());
    assert.equal(reclaim(join(dir, 'slot-1')), true);
    assert.equal(existsSync(join(dir, 'slot-1')), false);
  } finally {
    other.kill();
  }
});

test('REQ-GATE-29 one takeover at a time per slot, and a takeover lock is not counted as a slot in use', () => {
  const dir = tmp('keel-locks-');
  hold(dir, 0, deadPid());
  mkdirSync(join(dir, 'slot-0.takeover')); // another gate is taking slot-0 over right now
  assert.equal(reclaim(join(dir, 'slot-0')), false);
  assert.equal(existsSync(join(dir, 'slot-0')), true);
  assert.equal(slotsInUse(dir), 0);
});

test('REQ-GATE-29 a gate frees its slot only while the slot still holds its pid', () => {
  const dir = tmp('keel-locks-');
  const other = spawn('sleep', ['30']);
  try {
    withGateSlot({ dir, size: 1, sleep: () => {}, log: () => {} }, () => {
      writeFileSync(join(dir, 'slot-0', 'pid'), String(other.pid)); // the slot is another gate's now
    });
    assert.equal(readFileSync(join(dir, 'slot-0', 'pid'), 'utf8'), String(other.pid));
  } finally {
    other.kill();
  }
});
