import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, builderText, loadConfig, parseCard, readTrustedCard } from '../src/config.js';
import { join } from 'node:path';
import { commit, fixtureRepo, tmp, write } from './helpers.js';

test('REQ-CARD-1 parses header fields before the first ## heading and keeps the full text', () => {
  const text =
    '# BUI-12: Fix add\nkind: bug\nsize: M\npaths: src/**, test/**\nallowEdits: test/old.test.js\nheldOut: /h\n\n## Requirements\n- REQ-1: note: ignored here\n';
  const card = parseCard(text);
  assert.equal(card.id, 'BUI-12');
  assert.equal(card.kind, 'bug');
  assert.equal(card.size, 'M');
  assert.deepEqual(card.paths, ['src/**', 'test/**']);
  assert.deepEqual(card.allowEdits, ['test/old.test.js']);
  assert.equal(card.heldOut, '/h');
  assert.equal(card.text, text);
});

test('REQ-CARD-1 falls back to the file name for the id', () => {
  assert.equal(parseCard('# Add a thing\nkind: chore\nsize: S\n', '/x/my-card.md').id, 'my-card');
});

test('REQ-CARD-2 rejects missing or invalid kind and size, unknown headers, and unsafe ids', () => {
  assert.throws(() => parseCard('# X-1: t\nkind: rewrite\nsize: S\n'), /kind "rewrite"/);
  assert.throws(() => parseCard('# X-1: t\nsize: S\n'), /kind "undefined"/);
  assert.throws(() => parseCard('# X-1: t\nkind: bug\nsize: XL\n'), /size "XL"/);
  assert.throws(() => parseCard('# X-1: t\nkind: bug\nsize: S\nkindd: bug\n'), /unknown header "kindd"/);
  assert.throws(() => parseCard('# $(touch x)\nkind: bug\nsize: S\n', '/c/$(touch x).md'), /id "\$\(touch x\)"/);
});

test('REQ-GATE-10 builder text omits the held-out path', () => {
  const card = parseCard('# X-1: t\nkind: bug\nsize: M\nheldOut: /secret/held\n\n## Req\n');
  assert.ok(!builderText(card).includes('/secret/held'));
  assert.match(builderText(card), /## Req/);
});

test('REQ-CFG-1 has no default checks or testCommand: an unconfigured project fails with a keel init pointer', () => {
  const { dir, base } = fixtureRepo();
  assert.throws(() => loadConfig(dir, base), /keel init/);
});

test('REQ-CFG-1 reads keel.json from a git ref, not the working tree, and defaults heldOutCommand to testCommand', () => {
  const { dir, base } = fixtureRepo();
  const withChecks = { checks: { test: 'npm test' }, testCommand: 'npm test' };
  const head = commit(dir, { 'keel.json': JSON.stringify({ ...withChecks, maxAttempts: 2 }) });
  const config = loadConfig(dir, head);
  assert.equal(config.maxAttempts, 2);
  assert.equal(config.heldOutCommand, 'npm test');
  const head2 = commit(dir, { 'keel.json': JSON.stringify(withChecks) });
  assert.equal(loadConfig(dir, head2).maxAttempts, DEFAULTS.maxAttempts, 'unset keys still take the shared default');
  assert.throws(() => loadConfig(dir, base), /keel init/, 'the base ref keeps its own (missing) rules');
});

test('REQ-CFG-1 rejects unknown keys, inherited names, and invalid values', () => {
  const { dir } = fixtureRepo();
  const withChecks = { checks: { test: 'npm test' }, testCommand: 'npm test' };
  const at = (cfg) => commit(dir, { 'keel.json': JSON.stringify({ ...withChecks, ...cfg }) });
  assert.throws(() => loadConfig(dir, at({ maxAttempt: 2 })), /unknown keys: maxAttempt/);
  assert.throws(() => loadConfig(dir, at({ toString: 'x' })), /unknown keys: toString/);
  assert.throws(() => loadConfig(dir, at({ checks: {} })), /checks/);
  assert.throws(() => loadConfig(dir, at({ tiers: [] })), /tiers/);
  assert.throws(() => loadConfig(dir, at({ startTier: { L: 9, protected: 1 } })), /startTier.L/);
  assert.throws(() => loadConfig(dir, at({ shareDirs: ['../x'] })), /shareDirs/);
});

test('REQ-CFG-1 default start tiers are clamped to the configured tiers; explicit ones are validated', () => {
  const { dir } = fixtureRepo();
  const one = commit(dir, {
    'keel.json': JSON.stringify({
      checks: { test: 'npm test' },
      testCommand: 'npm test',
      tiers: [{ provider: 'codex', model: 'm', effort: 'low' }],
    }),
  });
  assert.deepEqual(loadConfig(dir, one).startTier, { L: 0, protected: 0 });
});

test('REQ-CARD-3 a card inside the repo is read from the base commit; outside cards are read from disk', () => {
  const { dir } = fixtureRepo();
  const base = commit(dir, { 'cards/T-1.md': '# T-1: t\nkind: bug\nsize: M\n' });
  commit(dir, { 'cards/T-1.md': '# T-1: t\nkind: chore\nsize: S\n' }); // candidate downgrades its own card
  assert.equal(readTrustedCard(dir, base, join(dir, 'cards/T-1.md')).kind, 'bug');
  commit(dir, { 'cards/T-2.md': '# T-2: t\nkind: chore\nsize: S\n' });
  assert.throws(() => readTrustedCard(dir, base, join(dir, 'cards/T-2.md')), /not in the base commit/);
  const outside = tmp('keel-cards-');
  write(outside, { 'T-3.md': '# T-3: t\nkind: feature\nsize: S\n' });
  assert.equal(readTrustedCard(dir, base, join(outside, 'T-3.md')).id, 'T-3');
});
