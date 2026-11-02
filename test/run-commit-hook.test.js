import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = () => parseCard('# T-65: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b.\n');
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

test('REQ-RUN-65 a commit rejected by a pre-commit hook is a failed attempt whose summary has the hook output', () => {
  const { dir } = fixtureRepo();
  // 60 lines of hook output: only the last 40 are the summary.
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\ni=1\nwhile [ $i -le 60 ]; do echo "hook line $i: UNSAFE_PARSING" >&2; i=$((i+1)); done\nexit 1\n');
  chmodSync(hook, 0o755);
  const prompts = tmp('keel-prompts-');
  const config = fixtureConfig({ tiers: [worker(prompts, 'weak'), worker(prompts, 'strong')], maxAttempts: 2, learnStart: false });
  const r = run({ repo: dir, card: card(), config, log: () => {} });

  assert.equal(r.pass, false);
  const rows = readLedger().filter((row) => row.card === 'T-65' && row.attempt !== undefined);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(row.gatePass, false);
    assert.equal(row.head, null);
    assert.match(row.failure ?? '', /commit failed/, 'the ledger row records why the attempt failed');
    assert.match(row.failure, /hook line 60: UNSAFE_PARSING/);
    assert.match(row.failure, /hook line 21: /);
    assert.doesNotMatch(row.failure, /hook line 20: /, 'only the last 40 lines are kept');
  }

  // The next attempt is told what the hook said.
  assert.deepEqual(readdirSync(prompts).sort(), ['prompt-1.txt', 'prompt-2.txt']);
  const second = readFileSync(join(prompts, 'prompt-2.txt'), 'utf8');
  assert.match(second, /hook line 60: UNSAFE_PARSING/);
  assert.doesNotMatch(readFileSync(join(prompts, 'prompt-1.txt'), 'utf8'), /UNSAFE_PARSING/);

  // The run's failure is the hook output too, and the staged work stays in the worktree.
  assert.match(r.failure, /hook line 60: UNSAFE_PARSING/);
  assert.match(g(r.worktree, 'status', '--porcelain'), /src\/add\.js/);
  assert.equal(readFileSync(join(r.worktree, 'src/add.js'), 'utf8'), EDIT);
});
