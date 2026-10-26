import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { exec } from '../src/git.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const quotaAuthor = { provider: 'exec', model: 'exec-author', effort: 'high', command: ['node', FAKE, 'quota'] };
const HELD = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n";
const goodAuthor = {
  provider: 'exec',
  model: 'exec-author',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const fs = require('fs');
fs.mkdirSync('test', { recursive: true });
fs.writeFileSync('test/held.test.js', ${JSON.stringify(HELD)});
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
  ],
};
const card = () => parseCard('# T-5: fix add\nkind: bug\nsize: M\n\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b.\n');
const branchExists = (dir, branch) => exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir).stdout.trim() !== '';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

test('REQ-RUN-41 a held-out author that fails on quota stops the run and removes the worktree and branch it made', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [builder, quotaAuthor], heldOutAuthorTier: 1 }) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'quota');
  assert.ok(!existsSync(r.worktree), `worktree still exists: ${r.worktree}`);
  assert.ok(!branchExists(dir, r.branch), `branch still exists: ${r.branch}`);
});

test('REQ-RUN-42 after a held-out-author stop, the next run on the same card starts without a "worktree exists" error', () => {
  const { dir } = fixtureRepo();
  const first = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [builder, quotaAuthor], heldOutAuthorTier: 1 }) });
  assert.equal(first.stopped, 'quota');
  const second = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [builder, goodAuthor], heldOutAuthorTier: 1 }) });
  assert.equal(second.pass, true, second.failure);
});
