import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuIdleShare, memoryLow } from '../src/slots.js';

test('REQ-SLOT-1 idle CPU is measured from CPU time deltas over a short sample, as a share from 0 to 1', () => {
  let slept = 0;
  const share = cpuIdleShare(50, (ms) => {
    slept = ms;
    const end = Date.now() + ms;
    while (Date.now() < end); // keep one core busy so the sample moves
  });
  assert.equal(slept, 50);
  assert.ok(share >= 0 && share <= 1, `share ${share}`);
});

test('REQ-SLOT-1 memory is short on macOS at critical pressure or under 15% available, on Linux under 15% MemAvailable', () => {
  const sysctl =
    (out, status = 0) =>
    () => ({ status, stdout: out });
  assert.equal(memoryLow('darwin', sysctl('2\n33\n')), false, 'warn pressure with a third available is not short');
  assert.equal(memoryLow('darwin', sysctl('4\n40\n')), true, 'critical pressure');
  assert.equal(memoryLow('darwin', sysctl('1\n9\n')), true, 'under 15% available');
  assert.equal(memoryLow('darwin', sysctl('', 1)), false, 'a failed reading leaves the CPU guard alone in charge');
  const meminfo = (avail) => () => `MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:   ${avail} kB\n`;
  assert.equal(memoryLow('linux', undefined, meminfo(1000000)), true);
  assert.equal(memoryLow('linux', undefined, meminfo(8000000)), false);
  assert.equal(memoryLow('win32'), false);
});
