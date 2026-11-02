import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardFromIssue, pickIssue } from '../src/linear.js';

const issue = (description, over = {}) => ({
  id: 'BUI-7',
  title: 'standardize on Node 24',
  description,
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Improvement'],
  estimate: null,
  ...over,
});

const BLOCK = '```keel\nkind: chore\nsize: M\npaths: .nvmrc, package.json, .github/**\nallowEdits: .github/workflows/quality.yml\n```\n';

test('REQ-LINEAR-12 a keel block overrides kind and size and supplies paths and allowEdits', () => {
  const card = cardFromIssue(issue(`${BLOCK}\n- REQ-1: node shall be 24.\n`));
  assert.equal(card.kind, 'chore');
  assert.equal(card.size, 'M');
  assert.deepEqual(card.paths, ['.nvmrc', 'package.json', '.github/**']);
  assert.deepEqual(card.allowEdits, ['.github/workflows/quality.yml']);
});

test('REQ-LINEAR-12 the block is removed from the requirements text', () => {
  const card = cardFromIssue(issue(`Intro line.\n\n${BLOCK}\n- REQ-1: node shall be 24.\n`));
  assert.ok(!card.text.includes('```'), 'the fenced block is not repeated in the requirements');
  assert.match(card.text, /REQ-1: node shall be 24/);
  assert.match(card.text, /Intro line/);
});

test('REQ-LINEAR-12 without a block, kind and size derive from label and estimate as before', () => {
  const card = cardFromIssue(issue('- REQ-1: x.', { labels: ['Bug'], estimate: 3 }));
  assert.equal(card.kind, 'bug');
  assert.equal(card.size, 'M');
  assert.deepEqual(card.allowEdits, []);
});

test('REQ-LINEAR-12 a block may set only part of the header; the rest still derives', () => {
  const card = cardFromIssue(issue('```keel\nallowEdits: package.json\n```\n- REQ-1: x.', { labels: ['Bug'], estimate: 1 }));
  assert.equal(card.kind, 'bug');
  assert.equal(card.size, 'S');
  assert.deepEqual(card.allowEdits, ['package.json']);
});

test('REQ-LINEAR-12 an unknown key rejects the card, so pick skips the issue with a reason', () => {
  const bad = issue('```keel\nallowEdit: package.json\n```\n- REQ-1: x.');
  assert.throws(() => cardFromIssue(bad), /unknown header "allowEdit"/);
  const skipped = [];
  assert.equal(
    pickIssue([bad], new Set(), (id, why) => skipped.push([id, why])),
    null,
  );
  assert.equal(skipped[0][0], 'BUI-7');
  assert.match(skipped[0][1], /allowEdit/);
});

test('REQ-LINEAR-12 a YAML list line in the block names the one-line form', () => {
  assert.throws(
    () => cardFromIssue(issue('```keel\npaths:\n  - src/a.js\n```\n- REQ-1: x.')),
    /YAML list is not read: write `paths: a, b` on one line/,
  );
});

test('REQ-LINEAR-12 a malformed line in the block rejects the card', () => {
  assert.throws(() => cardFromIssue(issue('```keel\nnot a header line\n```\n- REQ-1: x.')), /keel block/);
});
