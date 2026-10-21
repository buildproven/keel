import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { poll } from '../src/poll.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const tier = (name) => ({
  provider: 'exec',
  model: name,
  effort: 'low',
  command: ['node', FAKE, 'good'],
  family: name,
});
const card = () => parseCard('# BUI-1480: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const ignoredTestConfig = (over = {}) =>
  fixtureConfig({
    checks: { test: 'node test/basic.test.js' },
    testCommand: 'node test/basic.test.js',
    heldOutCommand: 'node test/basic.test.js',
    learnStart: false,
    ...over,
  });

let logFile;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-config-stop-state-');
  logFile = join(tmp('keel-config-stop-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
});

const calls = () =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('REQ-RUN-49 an unseen new test stops the run as config after one attempt', () => {
  const { dir } = fixtureRepo();
  const result = run({
    repo: dir,
    card: card(),
    config: ignoredTestConfig({ tiers: [tier('cheap'), tier('strong')], maxAttempts: 2 }),
  });

  assert.equal(result.pass, false);
  assert.equal(result.stopped, 'config');
  assert.equal(calls().length, 1);
  assert.match(result.failure, /test\/add\.test\.js/);
  assert.match(result.failure, /set `testFilesCommand` or make `testCommand` run (?:it|them)/i);
});

test('REQ-RUN-49 poll comments the config stop and blocks the issue', async () => {
  const { dir } = fixtureRepo();
  const calls = [];
  const client = {
    listIssues: async () => [
      {
        id: 'BUI-1480',
        title: 'fix add',
        description: '- REQ-ADD-1: add shall sum.',
        priority: 2,
        createdAt: '2026-10-21',
        labels: ['Bug'],
        estimate: 1,
        blockedBy: [],
      },
    ],
    stateType: async () => 'started',
    comment: async (id, body) => calls.push({ id, body }),
    review: async (id) => calls.push({ id, action: 'review' }),
  };
  const failure = 'New test files not run: test/add.test.js. Set `testFilesCommand` or make `testCommand` run them.';
  const [result] = await poll({
    repo: dir,
    project: 'x',
    client,
    config: {},
    runFn: () => ({ pass: false, stopped: 'config', failure, worktree: '/wt', branch: 'keel/BUI-1480' }),
  });

  assert.equal(result.outcome, 'blocked');
  assert.deepEqual(calls, [{ id: 'BUI-1480', body: failure }]);
});

test('REQ-RUN-49 passes-on-base without the hint still escalates', () => {
  const { dir } = fixtureRepo();
  const namesButIgnoresTest = 'node test/basic.test.js; echo test/add.test.js';
  const result = run({
    repo: dir,
    card: card(),
    config: ignoredTestConfig({
      checks: { test: namesButIgnoresTest },
      testCommand: namesButIgnoresTest,
      heldOutCommand: namesButIgnoresTest,
      tiers: [tier('cheap'), tier('strong')],
      maxAttempts: 2,
    }),
  });

  assert.equal(result.stopped, 'max-attempts');
  assert.equal(calls().length, 2);
  assert.match(calls()[1].prompt, /test-passes-on-base/);
  assert.doesNotMatch(calls()[1].prompt, /no new test file appears/);
});
