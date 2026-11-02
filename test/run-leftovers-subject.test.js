import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { isLeftoversCommit, leftoversMessage } from '../src/autoclean.js';
import { parseCard } from '../src/config.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = (kind, title) => parseCard(`# ${title}\nkind: ${kind}\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`);
const edit = `require('fs').writeFileSync('notes.txt', 'new file\\n');`;
const tier = { provider: 'exec', model: 'exec-left', effort: 'low', command: ['node', '-e', edit] };
const config = () => fixtureConfig({ tiers: [tier], maxAttempts: 1, learnStart: false });

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/** Runs a card whose worker only edits a file, so Keel commits the leftovers; returns the commit's subject and body. */
function leftoversOf(kind, title) {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(kind, title), config: config() });
  const sha = g(r.worktree, 'rev-list', '--max-parents=1', '--grep=leftovers', '-1', 'HEAD');
  return { subject: g(r.worktree, 'log', '-1', '--format=%s', sha), body: g(r.worktree, 'log', '-1', '--format=%b', sha) };
}

test('REQ-RUN-7 leftovers commit uses the card type and title (bug, feature, chore cards)', () => {
  for (const [kind, title, subject] of [
    ['bug', 'T-60: fix add', 'fix(T-60): fix add'],
    ['feature', 'T-61: add sub', 'feat(T-61): add sub'],
    ['ui', 'T-62: add a page', 'feat(T-62): add a page'],
    ['chore', 'T-63: tidy up', 'chore(T-63): tidy up'],
    ['refactor', 'T-64: split it', 'chore(T-64): split it'],
    ['infra', 'T-65: bump ci', 'chore(T-65): bump ci'],
  ]) {
    const c = leftoversOf(kind, title);
    assert.equal(c.subject, subject, kind);
    assert.equal(c.body, 'keel attempt 1 leftovers', kind);
  }
});

test('REQ-RUN-7 a long card title is shortened so the leftovers subject is at most 72 characters', () => {
  const title = `T-66: ${'long title words '.repeat(10)}end`;
  const { subject, body } = leftoversOf('bug', title);
  assert.equal(subject.length, 72);
  assert.match(subject, /^fix\(T-66\): long title words long title words .*…$/);
  assert.equal(body, 'keel attempt 1 leftovers');
  const exact = `T-67: ${'x'.repeat(72 - 'fix(T-67): '.length)}`;
  assert.equal(leftoversMessage(card('bug', exact), 2).split('\n')[0].length, 72, 'a title that just fits is kept whole');
  assert.ok(!leftoversMessage(card('bug', exact), 2).includes('…'));
});

test('REQ-RUN-7 a title that holds only the card id keeps the id as its text', () => {
  const [subject] = leftoversMessage(card('feature', 'T-68'), 3).split('\n');
  assert.equal(subject, 'feat(T-68): T-68');
});

test('REQ-CLEAN-3 isLeftoversCommit accepts the new and the old subject, and nothing else', () => {
  const body = 'keel attempt 2 leftovers';
  assert.ok(isLeftoversCommit('T-1', { subject: 'fix(T-1): a title', body }));
  assert.ok(isLeftoversCommit('T-1', { subject: 'chore(T-1): keel attempt 2 leftovers', body: '' }));
  assert.ok(!isLeftoversCommit('T-1', { subject: 'fix(T-1): a title', body: 'other' }), 'no body line, not Keel’s');
  assert.ok(!isLeftoversCommit('T-1', { subject: 'fix(T-2): a title', body }), 'another card');
  assert.ok(!isLeftoversCommit('T-1', { subject: 'docs(T-1): a title', body }), 'a type Keel never writes');
});
