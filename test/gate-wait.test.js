import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { timingLine, waitLines } from '../src/timing.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const results = [
  { name: 'lint', pass: true, problems: [], ms: 4_000 },
  { name: 'test', pass: true, problems: [], ms: 60_000 },
];

test('REQ-GATE-47 the timing line leads with the slot wait and counts it in the total', () => {
  assert.equal(timingLine(results, 252_000), 'timing wait 4m12s · lint 4s · test 60s · total 5m16s');
  assert.equal(timingLine(results, 400), 'timing lint 4s · test 60s · total 64s', 'under a second is no wait');
});

test('REQ-GATE-47 a wait over a minute earns an IMPROVE line naming the cause', () => {
  assert.deepEqual(waitLines(60_000), []);
  assert.match(waitLines(252_000)[0], /^IMPROVE: waited 4m12s for gate slots: .*slots follow idle CPU/);
});

test('REQ-GATE-47 a slotted gate records its wait on the receipt and in gate-times.jsonl', () => {
  const state = tmp('keel-state-');
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const r = gate({ repo: dir, base, card, config: fixtureConfig(), receiptDir: join(state, 'receipts'), slotDir: join(state, 'locks') });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  assert.equal(typeof r.waitMs, 'number');
  const [row] = readFileSync(join(state, 'gate-times.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(row.waitMs, r.waitMs);
});
