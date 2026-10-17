import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS, parseCard } from '../src/config.js';
import { buildPrompt, run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = parseCard('# T-7: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

test('REQ-RUN-18 the builder prompt tells the worker not to commit, because Keel commits its changes', () => {
  const prompt = buildPrompt(card, { ...DEFAULTS, checks: { test: 'npm test' } }, null);
  assert.match(prompt, /Do not commit/);
  assert.ok(!/Commit your work/.test(prompt), 'a sandboxed worker (Codex workspace-write) cannot write the git dir of a linked worktree');
});

test('REQ-RUN-18 a worker that only edits files, never committing, still passes: Keel commits the changes and gates them', () => {
  const { dir } = fixtureRepo();
  const edit = [
    "printf 'export const add = (a, b) => a + b;\\n' > src/add.js",
    "printf \"import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n\" > test/add.test.js",
  ].join(' && ');
  const tier = { provider: 'exec', model: 'exec-edit', effort: 'low', command: ['sh', '-c', `cat > /dev/null && ${edit}`] };
  const r = run({ repo: dir, card, config: fixtureConfig({ tiers: [tier] }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(g(r.worktree, 'status', '--porcelain'), '');
  assert.match(g(r.worktree, 'log', '-1', '--format=%s'), /^chore\(T-7\): keel attempt 1/);
});
