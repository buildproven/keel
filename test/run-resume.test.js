import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { sessionId, workerCommand } from '../src/workers.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const scriptFile = (modes) => {
  const file = join(tmp('keel-script-'), 'script.json');
  writeFileSync(file, JSON.stringify(modes));
  return file;
};
const tier = (file, model) => ({ provider: 'exec', model, effort: 'high', command: ['node', FAKE, 'script', file] });
const card = () => parseCard('# T-41: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
let logFile;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
});
const calls = () =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('REQ-RUN-33 the next tier of the same provider continues the session with only the failure', () => {
  const { dir } = fixtureRepo();
  const file = scriptFile(['fix-only', 'good']);
  const r = run({
    repo: dir,
    card: card(),
    config: fixtureConfig({ tiers: [tier(file, 'cheap'), tier(file, 'strong')], learnStart: false }),
  });
  assert.equal(r.pass, true);
  assert.equal(r.tier, 1);
  const [first, second] = calls();
  assert.equal(first.env.resume, undefined);
  assert.equal(second.env.resume, 's1', 'the session the first attempt printed');
  assert.equal(second.env.model, 'strong');
  assert.match(second.prompt, /previous attempt failed the gate[\s\S]*no-test-changed/);
  assert.ok(!second.prompt.includes('# Card'), 'the resumed session already has the card');
  const rows = readLedger().filter((x) => x.card === 'T-41');
  assert.deepEqual(
    rows.map((x) => [x.attempt, x.session ?? null, x.continued ?? false]),
    [
      [1, 's1', false],
      [2, 's2', true],
    ],
  );
});

test('REQ-RUN-33 a fresh exec worker never inherits a KEEL_RESUME from the environment', () => {
  const { dir } = fixtureRepo();
  process.env.KEEL_RESUME = 'stale-session';
  try {
    run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier(scriptFile(['good']), 'cheap')], learnStart: false }) });
  } finally {
    delete process.env.KEEL_RESUME;
  }
  assert.equal(calls()[0].env.resume, undefined);
});

test('REQ-RUN-33 another provider starts fresh, told which commits its branch already has', () => {
  const { dir } = fixtureRepo();
  const other = { provider: 'exec', model: 'other', effort: 'high', command: ['node', FAKE, 'good'] };
  const r = run({
    repo: dir,
    card: card(),
    config: fixtureConfig({ tiers: [tier(scriptFile(['fix-only']), 'cheap'), other], learnStart: false }),
  });
  assert.equal(r.pass, true);
  const [, second] = calls();
  assert.equal(second.env.resume, undefined);
  assert.match(second.prompt, /# Card/);
  assert.match(second.prompt, /your branch already has these commits:\n[0-9a-f]{7,} chore\(T-41\): keel attempt 1 leftovers/i);
});

test('REQ-RUN-33 claude resumes with --resume; codex with `exec resume <id> -`, the sandbox set by config', () => {
  const config = fixtureConfig();
  const claude = workerCommand({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'p', config, 'abc-1');
  const at = claude.args.indexOf('--resume');
  assert.ok(at !== -1 && claude.args[at + 1] === 'abc-1', claude.args.join(' '));
  assert.ok(claude.args.includes('-p') && claude.args.includes('claude-opus-5-5'));
  const codex = workerCommand({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' }, 'p', config, 'th-9');
  assert.deepEqual(codex.args.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(codex.args.slice(-2), ['th-9', '-']);
  assert.ok(codex.args.includes('sandbox_mode="workspace-write"'), codex.args.join(' '));
  assert.ok(!codex.args.includes('-s'), 'exec resume has no -s flag');
  assert.ok(!workerCommand({ provider: 'claude', model: 'm', effort: 'e' }, 'p', config).args.includes('--resume'));
});

test('REQ-RUN-33 the session id comes from Claude result JSON and from the Codex thread.started event', () => {
  assert.equal(sessionId('claude', '{"type":"result","session_id":"c-1","usage":{}}'), 'c-1');
  assert.equal(sessionId('exec', 'noise\n{"session_id":"e-2"}'), 'e-2');
  assert.equal(sessionId('codex', '{"type":"thread.started","thread_id":"t-3"}\n{"type":"turn.completed"}'), 't-3');
  assert.equal(sessionId('claude', 'not json'), null);
});
