import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { run } from '../src/run.js';
import { slotState } from '../src/slots.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));

test('REQ-GATE-29 keel run says when its gate waits for a slot', () => {
  const state = tmp('keel-state-');
  process.env.KEEL_STATE_DIR = state;
  process.env.KEEL_GATE_SLOTS = '1';
  // A holder that is not our child: init reaps it when it ends, as for another gate's process.
  const other = { pid: Number(spawnSync('sh', ['-c', 'sleep 3 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout) };
  mkdirSync(join(state, 'locks', 'slot-0'), { recursive: true });
  writeFileSync(join(state, 'locks', 'slot-0', 'pid'), String(other.pid));
  const { dir } = fixtureRepo();
  const said = [];
  try {
    const card = parseCard('# T-7: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
    const tiers = [{ provider: 'exec', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'], family: 'exec' }];
    const r = run({ repo: dir, card, config: fixtureConfig({ tiers }), log: (l) => said.push(l) });
    assert.equal(r.pass, true);
  } finally {
    delete process.env.KEEL_GATE_SLOTS;
  }
  assert.ok(
    said.some((l) => /^waiting for gate slot \(1 running of 1\)$/.test(l)),
    said.join('\n'),
  );
});

test('REQ-GATE-29 a slot released while it is read counts as free, not as an error', () => {
  const dir = tmp('keel-locks-');
  assert.equal(slotState(join(dir, 'slot-0')), 'free');
  mkdirSync(join(dir, 'slot-1'));
  assert.equal(slotState(join(dir, 'slot-1')), 'held', 'no pid yet: still starting');
  mkdirSync(join(dir, 'slot-2'));
  writeFileSync(join(dir, 'slot-2', 'pid'), String(2 ** 22 + 12345));
  assert.equal(slotState(join(dir, 'slot-2')), 'dead');
});
