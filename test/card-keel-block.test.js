import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CardError, builderText, parseCard } from '../src/config.js';
import { cardFromIssue } from '../src/linear.js';
import { BUGGY, FIXTURE_TEST, fixtureRepo, tmp } from './helpers.js';

const BLOCK = '```keel\npaths: src/a.js, test/a.test.js (new)\nallowEdits: scripts/run.sh\n```\n';
const file = (name) => `/cards/${name}.md`;

test('REQ-LINEAR-12 a keel block in a card file supplies paths and allowEdits', () => {
  const card = parseCard(`# BUI-1: t\nkind: bug\nsize: S\n\n## Requirements\n\n${BLOCK}\n- x\n`, file('BUI-1'));
  assert.deepEqual(card.paths, ['src/a.js', 'test/a.test.js']);
  assert.deepEqual(card.newPaths, ['test/a.test.js']);
  assert.deepEqual(card.allowEdits, ['scripts/run.sh']);
});

test('REQ-LINEAR-12 a keel block may supply kind, size and heldOut', () => {
  const card = parseCard(
    `# BUI-1: t\n\n## Requirements\n\n\`\`\`keel\nkind: feature\nsize: M\nheldOut: test/held.test.js\n\`\`\`\n`,
    file('BUI-1'),
  );
  assert.equal(card.kind, 'feature');
  assert.equal(card.size, 'M');
  assert.equal(card.heldOut, 'test/held.test.js');
});

test('REQ-LINEAR-12 a keel block above the first heading is read once, not also as headers', () => {
  const card = parseCard(`# BUI-1: t\nkind: bug\nsize: S\n${BLOCK}\n## Requirements\n- x\n`, file('BUI-1'));
  assert.deepEqual(card.allowEdits, ['scripts/run.sh']);
});

test('REQ-LINEAR-12 a field given in both the block and the header is a CardError', () => {
  assert.throws(
    () => parseCard('# BUI-1: t\nkind: bug\nsize: S\npaths: a.js\n\n## R\n\n```keel\npaths: b.js\n```\n', file('BUI-1')),
    (e) => e instanceof CardError && /header "paths" is given twice/.test(e.message) && /keel block/.test(e.message),
  );
});

test('REQ-LINEAR-12 a field given twice inside the block is a CardError', () => {
  assert.throws(
    () => parseCard('# BUI-1: t\nkind: bug\nsize: S\n\n## R\n\n```keel\npaths: a.js\npaths: b.js\n```\n', file('BUI-1')),
    (e) => e instanceof CardError && /"paths" is given twice/.test(e.message),
  );
});

test('REQ-LINEAR-12 an unknown key or a malformed line in the block is a CardError naming the keel block', () => {
  const card = (body) => `# BUI-1: t\nkind: bug\nsize: S\n\n## R\n\n\`\`\`keel\n${body}\n\`\`\`\n`;
  assert.throws(
    () => parseCard(card('pathz: a.js'), file('BUI-1')),
    (e) => e instanceof CardError && /unknown header "pathz"/.test(e.message),
  );
  assert.throws(
    () => parseCard(card('paths:\n  - a.js'), file('BUI-1')),
    (e) => e instanceof CardError && /malformed line in its keel block/.test(e.message) && /YAML list/.test(e.message),
  );
});

test('REQ-LINEAR-12 a card with no keel block reads headers as before', () => {
  const card = parseCard('# BUI-1: t\nkind: bug\nsize: S\npaths: a.js\n\n## R\n- x\n', file('BUI-1'));
  assert.deepEqual(card.paths, ['a.js']);
  assert.deepEqual(card.allowEdits, []);
});

test('REQ-LINEAR-12 the builder text hides a heldOut line inside the block', () => {
  const card = parseCard('# BUI-1: t\nkind: bug\nsize: S\n\n## R\n\n```keel\nheldOut: test/held.test.js\n```\n', file('BUI-1'));
  assert.doesNotMatch(builderText(card), /held\.test/);
});

test('REQ-LINEAR-12 a Linear issue card still maps through the same parser', () => {
  const card = cardFromIssue({
    id: 'BUI-7',
    title: 't',
    description: '```keel\npaths: a.js\n```\n- x\n',
    labels: ['Bug'],
    estimate: 1,
  });
  assert.deepEqual(card.paths, ['a.js']);
});

test('REQ-CARD-2 a card with a bad kind and a bad size names both', () => {
  assert.throws(
    () => parseCard('# BUI-1: t\nkind: bogus\nsize: Z\n', file('BUI-1')),
    (e) =>
      e instanceof CardError && /header "kind:" is invalid.*"bogus"/.test(e.message) && /header "size:" is invalid.*"Z"/.test(e.message),
  );
});

test('REQ-CARD-2 a card missing kind and size names both', () => {
  assert.throws(
    () => parseCard('# BUI-1: t\npaths: a.js\n', file('BUI-1')),
    (e) => e instanceof CardError && /"kind:" is missing/.test(e.message) && /"size:" is missing/.test(e.message),
  );
});

test('REQ-CARD-2 a card with one bad header names only that one', () => {
  assert.throws(
    () => parseCard('# BUI-1: t\nkind: bug\nsize: Z\n', file('BUI-1')),
    (e) => e instanceof CardError && /"size:" is invalid/.test(e.message) && !/"kind:"/.test(e.message),
  );
});

test('REQ-CARD-2 keel gate --card with invalid headers exits 2 and names every bad header', () => {
  const dir = fixtureRepo({
    ...BUGGY,
    'keel.json': `${JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST })}\n`,
  }).dir;
  const card = join(tmp('keel-card-'), 'bad.md');
  writeFileSync(card, '# BUI-9: t\nkind: bogus\nsize: Z\n');
  const bin = new URL('../bin/keel.js', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, 'gate', '--base', 'HEAD', '--card', card, '--repo', dir], {
    encoding: 'utf8',
    env: { ...process.env, KEEL_STATE_DIR: tmp('keel-state-') },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /"kind:" is invalid/);
  assert.match(r.stderr, /"size:" is invalid/);
});
