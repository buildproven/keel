import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { cardFromIssue } from '../src/linear.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = (acceptance) =>
  parseCard(`# T-1: acceptance\nkind: chore\nsize: S\n${acceptance === undefined ? '' : `acceptance: ${acceptance}\n`}`);
const run = (config, acc) => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  return { dir, receipt: gate({ repo: dir, base, card: card(acc), config }) };
};
const names = (receipt) => receipt.results.map((r) => r.name);

test('REQ-CARD-4 a card lists acceptance names, and a bad name is rejected', () => {
  assert.deepEqual(card('audit, build-ok').acceptance, ['audit', 'build-ok']);
  assert.deepEqual(card().acceptance, []);
  assert.throws(() => card('rm -rf /'), /acceptance name/);
  assert.throws(() => card('a b'), /acceptance name/);
});

test('REQ-GATE-15 a named acceptance command runs after the checks and passes the gate', () => {
  const { receipt } = run(fixtureConfig({ acceptance: { ok: 'true' } }), 'ok');
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results));
  assert.ok(names(receipt).includes('acceptance:ok'));
  assert.ok(names(receipt).indexOf('acceptance:ok') > names(receipt).indexOf('test'));
});

test('REQ-GATE-15 a failing acceptance command fails the gate even though every check passed', () => {
  const { receipt } = run(fixtureConfig({ acceptance: { audit: 'exit 3' } }), 'audit');
  assert.equal(receipt.pass, false);
  const stage = receipt.results.find((r) => r.name === 'acceptance:audit');
  assert.equal(stage.pass, false);
  assert.ok(receipt.results.filter((r) => !r.name.startsWith('acceptance:')).every((r) => r.pass));
});

test('REQ-GATE-15 an undefined acceptance name fails as unknown-acceptance and runs nothing', () => {
  const marker = join(tmp('keel-acc-'), 'ran');
  const { receipt } = run(fixtureConfig({ acceptance: { other: `touch ${marker}` } }), 'missing');
  assert.equal(receipt.pass, false);
  assert.deepEqual(
    receipt.results.flatMap((r) => r.problems.map((p) => p.rule)),
    ['unknown-acceptance'],
  );
  assert.equal(existsSync(marker), false);
});

test('REQ-GATE-15 acceptance commands run without secret-looking variables', () => {
  const cmd = `node -e "process.exit(process.env.KEEL_ACC_SECRET_TOKEN ? 1 : 0)"`;
  process.env.KEEL_ACC_SECRET_TOKEN = 'secret';
  try {
    const { receipt } = run(fixtureConfig({ acceptance: { env: cmd } }), 'env');
    assert.equal(receipt.pass, true, JSON.stringify(receipt.results));
  } finally {
    delete process.env.KEEL_ACC_SECRET_TOKEN;
  }
});

test('REQ-CFG-1 acceptance defaults to none and must be a table of non-empty command strings', () => {
  assert.deepEqual(DEFAULTS.acceptance, {});
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  for (const bad of ['npm audit', ['x'], { a: '' }, { a: 5 }, { 'bad name': 'true' }])
    assert.throws(() => loadConfig(dir, at({ acceptance: bad })), /acceptance/);
  assert.deepEqual(loadConfig(dir, at({ acceptance: { audit: 'npm audit' } })).acceptance, { audit: 'npm audit' });
});

test('REQ-LINEAR-12 REQ-CARD-4 a keel block can select acceptance names for an issue card', () => {
  const issue = { id: 'BUI-8', title: 't', description: '```keel\nacceptance: audit\n```\n- REQ-1: x.', labels: ['Bug'], estimate: null };
  assert.deepEqual(cardFromIssue(issue).acceptance, ['audit']);
});
