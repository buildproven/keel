import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FIXED_SRC, FIXTURE_TEST, commit, fixtureRepo, g, tmp } from './helpers.js';

const tier = (family, model) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0); console.log('VERDICT: pass')"],
});
const codex = tier('codex', 'exec-codex');
const claude = tier('claude', 'exec-claude');
const WINDOW = { hours: 5, tokens: 1000 };

/** The output of `keel gate` written by claude, with the codex window nearly used and `spent` more per family. */
function gateOutput(cfg, spent = {}) {
  const { dir } = fixtureRepo();
  const keelJson = { checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: true, ...cfg };
  commit(dir, { 'keel.json': JSON.stringify(keelJson) }, 'chore: cfg');
  g(dir, 'branch', '-q', '-f', 'base');
  g(dir, 'checkout', '-q', '-b', 'work');
  commit(dir, FIXED_SRC, 'chore: change');
  const state = tmp('keel-state-');
  for (const [family, tokens] of Object.entries({ codex: 950, ...spent }))
    appendFileSync(join(state, 'review-spend.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), family, tokens })}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'KEEL_AUTHOR'));
  const run = spawnSync(process.execPath, [resolve('bin/keel.js'), 'gate', '--base', 'base', '--author', 'claude'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, KEEL_STATE_DIR: state },
  });
  return `${run.stdout}${run.stderr}`;
}

const windowLine = (out) => out.split('\n').find((l) => l.includes('review window codex'));

test('REQ-GATE-24 keel gate names the fallback that reviews first when the reviewer window is nearly used', () => {
  const line = windowLine(gateOutput({ reviewWindows: { codex: WINDOW }, tiers: [claude, codex] }));
  assert.match(line, /nearly used: fallback exec\/exec-claude\/high reviews first/);
});

test('REQ-GATE-24 keel gate does not claim a fallback reviews first when reviewFallback is off', () => {
  const line = windowLine(gateOutput({ reviewFallback: false, reviewWindows: { codex: WINDOW }, tiers: [claude, codex] }));
  assert.match(line, /nearly used/);
  assert.doesNotMatch(line, /fallback .*reviews first/);
  assert.match(line, /exec\/exec-codex\/high still reviews/);
});

test('REQ-GATE-24 keel gate does not claim a fallback reviews first when there is no fallback', () => {
  const line = windowLine(gateOutput({ reviewWindows: { codex: WINDOW }, tiers: [codex] }));
  assert.doesNotMatch(line, /fallback .*reviews first/);
  assert.match(line, /exec\/exec-codex\/high still reviews/);
});

test('REQ-GATE-24 keel gate does not claim a fallback reviews first when every fallback window is also nearly used', () => {
  const line = windowLine(gateOutput({ reviewWindows: { codex: WINDOW, claude: WINDOW }, tiers: [claude, codex] }, { claude: 950 }));
  assert.doesNotMatch(line, /fallback .*reviews first/);
  assert.match(line, /exec\/exec-codex\/high still reviews/);
});
