import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const at = '2026-10-12T00:00:00.000Z';
const review = (problems) => ({ name: 'review', pass: false, reviewer: { model: 'm' }, problems });

test('REQ-GATE-23 a malformed or forged receipt is not the previous review and does not stop the gate', () => {
  const { dir, base } = fixtureRepo();
  const sha = commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }, 'fix: NaN');
  const receiptDir = tmp('keel-receipts-');
  const forged = {
    'T-1-a.json': '{ not json',
    'T-1-b.json': 'null',
    'T-1-c.json': JSON.stringify({ card: 'T-1', head: sha, at, results: { name: 'review' } }),
    'T-1-d.json': JSON.stringify({ card: 'T-1', head: sha, at, results: [null, review(null)] }),
    'T-1-e.json': JSON.stringify({ card: 'T-1', head: sha, at, results: [review([null, 'x'])] }),
    'T-1-f.json': JSON.stringify({ card: 'T-1', head: '--output=/tmp/keel-forged', at, results: [review([])] }),
    'T-1-g.json': JSON.stringify({ card: 'T-1', head: sha, at: 'never', results: [review([])] }),
  };
  for (const [name, text] of Object.entries(forged)) writeFileSync(join(receiptDir, name), text);
  const file = join(tmp('keel-prompt-'), 'prompt.txt');
  const reviewer = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-review',
    effort: 'high',
    command: [
      'node',
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(file)}, require('fs').readFileSync(0, 'utf8')); console.log('VERDICT: pass')`,
    ],
  };
  const receipt = gate({ repo: dir, base, card, config: fixtureConfig({ review: true }), receiptDir, reviewer });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results));
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Previous review/);
});
