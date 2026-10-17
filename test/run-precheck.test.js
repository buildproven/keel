import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
/** One exec tier that plays `modes` in order, one per worker call (fake-worker `script`). */
const scripted = (modes, model = 'm') => {
  const file = join(tmp('keel-script-'), 'script.json');
  writeFileSync(file, JSON.stringify(modes));
  return { provider: 'exec', model, effort: 'high', command: ['node', FAKE, 'script', file] };
};
const card = (header = 'kind: bug\nsize: S') => parseCard(`# T-40: fix add\n${header}\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`);
let logFile;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
});
const calls = () =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('REQ-RUN-32 a locked edit gets one corrective turn on the same tier, naming the path and the rule, before any escalation', () => {
  const { dir } = fixtureRepo();
  const t = scripted(['edit-test', 'fix-locked']);
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [t, scripted(['good'], 'strong')], learnStart: false }) });
  assert.equal(r.pass, true);
  assert.equal(r.tier, 0, 'no escalation');
  assert.equal(r.attempt, 1, 'the corrective turn is part of attempt 1');
  const [, fix] = calls();
  assert.equal(calls().length, 2);
  assert.match(fix.prompt, /test\/basic\.test\.js/);
  assert.match(fix.prompt, /revert your edits to these locked files; put new tests in new files/i);
  assert.match(fix.prompt, /allowEdits: test\/basic\.test\.js/, 'an edit the card truly needs still goes to approval (REQ-RUN-30)');
  const rows = readLedger().filter((x) => x.card === 'T-40');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].corrective, { rules: ['existing-test-changed'], paths: ['test/basic.test.js'] });
  assert.equal(rows[0].cost, 0.02, 'both turns are priced into the attempt');
  assert.deepEqual(rows[0].usage, { in: 200, out: 20, cached: 100 });
});

test('REQ-RUN-32 an out-of-scope change gets one corrective turn that names the path', () => {
  const { dir } = fixtureRepo();
  const t = scripted(['out-of-scope', 'good']);
  const header = 'kind: bug\nsize: S\npaths: src/**, test/**';
  const r = run({ repo: dir, card: card(header), config: fixtureConfig({ tiers: [t, scripted(['good'], 'strong')], learnStart: false }) });
  assert.equal(r.pass, false, 'good does not delete docs/notes.md, so the full gate still fails on scope');
  const [, fix] = calls();
  assert.match(fix.prompt, /docs\/notes\.md/);
  assert.match(fix.prompt, /out-of-scope/);
  assert.deepEqual(readLedger().find((x) => x.card === 'T-40' && x.attempt === 1).corrective, {
    rules: ['out-of-scope'],
    paths: ['docs/notes.md'],
  });
});

test('REQ-RUN-32 only one corrective turn per attempt: a second locked edit fails the gate and escalates as before', () => {
  const { dir } = fixtureRepo();
  const r = run({
    repo: dir,
    card: card(),
    config: fixtureConfig({ tiers: [scripted(['edit-test', 'edit-test']), scripted(['fix-locked'], 'strong')], learnStart: false }),
  });
  assert.equal(r.pass, true);
  assert.equal(r.tier, 1);
  assert.equal(r.attempt, 2);
  assert.equal(calls().length, 3);
  const first = readLedger().find((x) => x.card === 'T-40' && x.attempt === 1);
  assert.equal(first.gatePass, false);
});

test('REQ-RUN-32 a clean static stage runs no corrective turn', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [scripted(['good'])], learnStart: false }) });
  assert.equal(r.pass, true);
  assert.equal(calls().length, 1);
  assert.equal(readLedger().find((x) => x.card === 'T-40').corrective, undefined);
});
