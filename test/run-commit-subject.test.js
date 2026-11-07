import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = (title) => parseCard(`# T-67: ${title}\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b.\n`);
const EDIT = 'export const add = (a, b) => a + b;\n';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/** A worker that saves each prompt it is given as prompt-<n>.txt in `dir`, then edits a file and exits ok. */
const worker = (dir, model) => ({
  provider: 'exec',
  model,
  effort: 'low',
  command: [
    'node',
    '-e',
    `const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
const n = fs.readdirSync(${JSON.stringify(dir)}).length + 1;
fs.writeFileSync(${JSON.stringify(dir)} + '/prompt-' + n + '.txt', prompt);
fs.writeFileSync('src/add.js', ${JSON.stringify(EDIT)});
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
  ],
});

/**
 * A commit-msg hook that logs each subject it sees to `seen`, then runs `body` (sh) with the subject in $s. Its output
 * mimics commitlint's (`@commitlint/config-conventional` rejects any subject whose first letter is upper case as
 * sentence-case).
 */
function commitMsgHook(dir, seen, body) {
  const hook = join(dir, '.git', 'hooks', 'commit-msg');
  writeFileSync(hook, `#!/bin/sh\ns=$(head -n 1 "$1" | sed 's/^[^:]*: //')\necho "$s" >> '${seen}'\n${body}\n`);
  chmodSync(hook, 0o755);
}

// The hooks below are sh scripts that git runs with this process's environment. A `case` range such as `[A-Z]`
// follows the locale's collation (under en_US.UTF-8 it matches lower case too), so pin the C locale.
process.env.LC_ALL = 'C';

const SUBJECT_CASE =
  'case "$s" in [A-Z]*) echo "⧗   input: $(head -n 1 "$1")"; echo "✖   subject must not be sentence-case [subject-case]"; exit 1;; esac\nexit 0';

const subjects = (seen) => (existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n') : []);

test('REQ-RUN-67 a sentence-case title is committed with a lower-case subject when commitlint rejects it', () => {
  const { dir } = fixtureRepo();
  const seen = join(tmp('keel-seen-'), 'subjects');
  commitMsgHook(dir, seen, SUBJECT_CASE);
  const prompts = tmp('keel-prompts-');
  const config = fixtureConfig({ tiers: [worker(prompts, 'weak')], maxAttempts: 1, learnStart: false });
  const r = run({ repo: dir, card: card('Share the SEC add across processes'), config, log: () => {} });

  assert.deepEqual(subjects(seen), ['Share the SEC add across processes', 'share the SEC add across processes']);
  const [row] = readLedger().filter((x) => x.card === 'T-67' && x.attempt !== undefined);
  assert.notEqual(row.head, null, JSON.stringify(row));
  assert.doesNotMatch(row.failure ?? '', /commit failed/);
  assert.equal(g(r.worktree, 'log', '-1', '--format=%s').trim(), 'fix(T-67): share the SEC add across processes');
  assert.match(g(r.worktree, 'log', '-1', '--format=%b'), /keel attempt 1 leftovers/, 'the body still marks it as Keel’s');
  assert.equal(g(r.worktree, 'status', '--porcelain').trim(), '');
});

test('REQ-RUN-67 a title the hook accepts is committed unchanged, with one commit try', () => {
  const { dir } = fixtureRepo();
  const seen = join(tmp('keel-seen-'), 'subjects');
  commitMsgHook(dir, seen, SUBJECT_CASE);
  const prompts = tmp('keel-prompts-');
  const config = fixtureConfig({ tiers: [worker(prompts, 'weak')], maxAttempts: 1, learnStart: false });
  const r = run({ repo: dir, card: card('fix add for SEC'), config, log: () => {} });

  assert.deepEqual(subjects(seen), ['fix add for SEC']);
  assert.equal(g(r.worktree, 'log', '-1', '--format=%s').trim(), 'fix(T-67): fix add for SEC');
});

test('REQ-RUN-67 another hook failure keeps the hook output for the next attempt', () => {
  const { dir } = fixtureRepo();
  const seen = join(tmp('keel-seen-'), 'subjects');
  commitMsgHook(dir, seen, 'echo "✖   header must not be longer than 10 characters [header-max-length]"\nexit 1');
  const prompts = tmp('keel-prompts-');
  const config = fixtureConfig({ tiers: [worker(prompts, 'weak'), worker(prompts, 'strong')], maxAttempts: 2, learnStart: false });
  const r = run({ repo: dir, card: card('Share the SEC add'), config, log: () => {} });

  assert.equal(r.pass, false);
  assert.deepEqual(subjects(seen), ['Share the SEC add', 'Share the SEC add'], 'no retry: the hook named no subject-case');
  const rows = readLedger().filter((x) => x.card === 'T-67' && x.attempt !== undefined);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.head, null);
    assert.match(row.failure ?? '', /commit failed[\s\S]*\[header-max-length\]/);
  }
  assert.deepEqual(readdirSync(prompts).sort(), ['prompt-1.txt', 'prompt-2.txt']);
  assert.match(readFileSync(join(prompts, 'prompt-2.txt'), 'utf8'), /\[header-max-length\]/);
  assert.match(g(r.worktree, 'status', '--porcelain'), /src\/add\.js/, 'the staged work stays');
});

test('REQ-RUN-67 a lower-cased subject the hook still rejects fails with the retry’s output', () => {
  const { dir } = fixtureRepo();
  const seen = join(tmp('keel-seen-'), 'subjects');
  const count = join(tmp('keel-count-'), 'n');
  commitMsgHook(
    dir,
    seen,
    `echo x >> '${count}'\necho "✖   try $(wc -l < '${count}' | tr -d ' ') subject must not be sentence-case [subject-case]"\nexit 1`,
  );
  const prompts = tmp('keel-prompts-');
  const config = fixtureConfig({ tiers: [worker(prompts, 'weak')], maxAttempts: 1, learnStart: false });
  const r = run({ repo: dir, card: card('Share the SEC add'), config, log: () => {} });

  assert.equal(r.pass, false);
  assert.deepEqual(subjects(seen), ['Share the SEC add', 'share the SEC add']);
  const [row] = readLedger().filter((x) => x.card === 'T-67' && x.attempt !== undefined);
  assert.equal(row.head, null);
  assert.match(row.failure, /commit failed[\s\S]*try 2 subject must not be sentence-case/);
  assert.match(g(r.worktree, 'status', '--porcelain'), /src\/add\.js/);
});

test('REQ-RUN-67 a subject that does not start with an upper-case letter is not retried', () => {
  const { dir } = fixtureRepo();
  const seen = join(tmp('keel-seen-'), 'subjects');
  commitMsgHook(dir, seen, 'echo "✖   subject must not be sentence-case [subject-case]"\nexit 1');
  const prompts = tmp('keel-prompts-');
  const config = fixtureConfig({ tiers: [worker(prompts, 'weak')], maxAttempts: 1, learnStart: false });
  run({ repo: dir, card: card('`Add` handles SEC'), config, log: () => {} });

  assert.deepEqual(subjects(seen), ['`Add` handles SEC']);
});
