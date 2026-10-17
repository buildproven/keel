import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const tier = (mode) => ({ provider: 'exec', family: 'exec', model: `m-${mode}`, effort: 'low', command: ['node', FAKE, mode] });

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

test('REQ-RUN-7 an attempt that leaves the keel/ branch fails alone: the worktree goes back on the branch, and the next tier can pass', () => {
  const { dir } = fixtureRepo();
  const card = parseCard('# T-6: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const r = run({ repo: dir, card, config: fixtureConfig({ tiers: [tier('detach'), tier('good')], learnStart: false, maxAttempts: 2 }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.attempt, 2);
  assert.equal(g(r.worktree, 'symbolic-ref', '--short', 'HEAD'), 'keel/T-6');
});
