import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { buildPrompt, resumePrompt, run } from '../src/run.js';
import { BUGGY, FIXTURE_TEST, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

// A builder that follows a script: call n runs behaviour n, and writes what it finds at its start to `seen.jsonl`.
const WORKER = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const [, , script] = process.argv;
const counter = script + '.n';
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(n + 1));
const mode = JSON.parse(readFileSync(script, 'utf8'))[n];
readFileSync(0, 'utf8');
const has = (p) => existsSync(p);
appendFileSync(script + '.seen', JSON.stringify({ mode, leak: has('src/leak.js'), notes: has('docs/notes.md'), readme: has('README.md') ? readFileSync('README.md', 'utf8') : null }) + '\\n');
const fix = () => {
  writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n');
  mkdirSync('test', { recursive: true });
  writeFileSync('test/add.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n");
};
if (mode === 'leak') { writeFileSync('src/leak.js', 'export const LEAKY_VALUE = 1;\\n'); }
if (mode === 'leak-fix') { fix(); writeFileSync('src/leak.js', 'export const LEAKY_VALUE = 1;\\n'); }
if (mode === 'unleak-fix') { fix(); rmSync('src/leak.js', { force: true }); }
if (mode === 'fix') fix();
if (mode === 'scatter') { writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n'); writeFileSync('README.md', 'changed\\n'); mkdirSync('docs', { recursive: true }); writeFileSync('docs/notes.md', 'notes\\n'); }
if (mode === 'delete') { writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n'); rmSync('README.md'); }
if (mode === 'blocked') writeFileSync('KEEL_BLOCKED', 'the card cannot be met\\n');
if (mode === 'locked-leak') { fix(); writeFileSync('src/leak.js', 'export const LEAKY_VALUE = 1;\\n'); writeFileSync('test/basic.test.js', '// edited\\n'); }
if (mode === 'unlock') { rmSync('src/leak.js', { force: true }); writeFileSync('test/basic.test.js', "import assert from 'node:assert';\\nassert.ok(true);\\n"); }
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0 } }));
`;

let workerFile;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  workerFile = join(tmp('keel-worker-'), 'worker.mjs');
  writeFileSync(workerFile, WORKER);
});

/** Tiers that each follow their own script, so a test says what attempt 1, attempt 2, ... do. */
function tiers(...scripts) {
  return scripts.map((modes, i) => {
    const script = join(tmp('keel-script-'), 'script.json');
    writeFileSync(script, JSON.stringify(modes));
    return { provider: 'exec', family: `f${i}`, model: `m${i}`, effort: 'low', command: ['node', workerFile, script], script };
  });
}
const seen = (t) =>
  readFileSync(`${t.script}.seen`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

// A check that reads history, as `gitleaks detect` does: it fails on a value an earlier commit held, whatever the tree holds now.
const HISTORY = '! git log -p --format= HEAD | grep -q LEAKY_VALUE';
const config = (t, over = {}) =>
  fixtureConfig({ tiers: t, learnStart: false, maxAttempts: 3, checks: { test: FIXTURE_TEST, history: HISTORY }, ...over });
const card = (header = 'kind: bug\nsize: S') => parseCard(`# T-69: fix add\n${header}\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`);
const subjects = (wt, base) => g(wt, 'log', '--format=%s', `${base}..HEAD`).split('\n').filter(Boolean);

test('REQ-RUN-69 attempt 2 starts on the base with attempt 1 uncommitted, so only one commit reaches history and none holds the leak', () => {
  const { dir, base } = fixtureRepo();
  const t = tiers(['leak-fix'], ['unleak-fix']);
  const out = [];
  const r = run({ repo: dir, card: card(), config: config(t), log: (l) => out.push(l) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.attempt, 2);
  assert.equal(subjects(r.worktree, base).length, 1, 'one commit between base and head');
  const [first, second] = readLedger().filter((x) => x.card === 'T-69' && !x.role);
  assert.equal(first.gatePass, false);
  assert.match(first.head, /^[0-9a-f]{40}$/);
  // Neither a branch nor any other ref holds the failed attempt's commit.
  assert.equal(g(dir, 'branch', '--all', '--contains', first.head), '');
  assert.equal(g(dir, 'for-each-ref', '--contains', first.head), '');
  assert.equal(second.restartedFrom, first.head, 'the ledger names the commit attempt 2 started from');
  assert.equal(first.restartedFrom, undefined);
  // Tier 1 saw the earlier diff in its working tree, uncommitted.
  assert.deepEqual(
    seen(t[1]).map((s) => s.leak),
    [true],
  );
  assert.ok(
    out.some((l) => l.includes(`attempt 1 failed on ${first.head}`)),
    out.join('\n'),
  );
});

test('REQ-RUN-69 the last attempt keeps its commit, so the parked worktree is clean', () => {
  const { dir, base } = fixtureRepo();
  const t = tiers(['leak'], ['leak']);
  const r = run({ repo: dir, card: card(), config: config(t, { maxAttempts: 2 }) });
  assert.equal(r.stopped, 'max-attempts');
  assert.equal(g(r.worktree, 'status', '--porcelain'), '');
  assert.equal(subjects(r.worktree, base).length, 1);
});

test('REQ-RUN-69 a blocked run leaves one commit on the base, and no ref holds an earlier attempt', () => {
  const { dir, base } = fixtureRepo();
  const t = tiers(['leak-fix'], ['blocked']);
  const r = run({ repo: dir, card: card(), config: config(t) });
  assert.equal(r.stopped, 'blocked');
  const [first] = readLedger().filter((x) => x.card === 'T-69' && !x.role);
  assert.equal(subjects(r.worktree, base).length, 1);
  assert.equal(g(r.worktree, 'status', '--porcelain'), '');
  assert.equal(g(dir, 'for-each-ref', '--contains', first.head), '');
});

test('REQ-RUN-69 a corrective turn in the same attempt does not leave the offending commit in history', () => {
  const { dir, base } = fixtureRepo();
  const t = tiers(['locked-leak', 'unlock']);
  const r = run({ repo: dir, card: card(), config: config(t) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.attempt, 1);
  assert.deepEqual(readLedger().find((x) => x.card === 'T-69').corrective?.rules, ['existing-test-changed']);
  assert.equal(subjects(r.worktree, base).length, 1);
  assert.equal(g(r.worktree, 'log', '-p', '--format=', 'HEAD').includes('LEAKY_VALUE'), false);
});

test('REQ-RUN-69 the next attempt prompt says the earlier changes are uncommitted in the working tree', () => {
  const c = card();
  const prompt = buildPrompt(c, fixtureConfig(), 'the gate failed', '', 'M src/add.js\n?? src/leak.js');
  assert.match(
    prompt,
    /# Your working tree already holds these uncommitted changes from the previous attempt:\nM src\/add\.js\n\?\? src\/leak\.js/,
  );
  assert.doesNotMatch(buildPrompt(c, fixtureConfig(), null), /uncommitted changes from the previous attempt/);
  assert.match(resumePrompt('x'), /still in the working tree, uncommitted/);
});

test('REQ-RUN-70 a file of the carried diff outside the card paths is dropped and logged; the rest is carried', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'README.md': 'base\n' });
  const t = tiers(['scatter', 'scatter'], ['fix']);
  const out = [];
  const header = 'kind: bug\nsize: S\npaths: src/**, test/**';
  const r = run({ repo: dir, card: card(header), config: config(t), log: (l) => out.push(l) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.tier, 1);
  const [tier1] = seen(t[1]);
  assert.equal(tier1.notes, false, 'a file the attempt added is removed');
  assert.equal(tier1.readme, 'base\n', 'a file the base has is restored');
  assert.ok(
    out.some((l) => /dropped 2 file\(s\) outside the card paths: (README\.md, docs\/notes\.md|docs\/notes\.md, README\.md)/.test(l)),
    out.join('\n'),
  );
  assert.deepEqual(g(r.worktree, 'diff', '--name-only', `${base}..HEAD`).split('\n').sort(), ['src/add.js', 'test/add.test.js']);
});

test('REQ-RUN-70 a card with no paths drops nothing', () => {
  const { dir } = fixtureRepo({ ...BUGGY, 'README.md': 'base\n' });
  const t = tiers(['scatter', 'scatter'], ['fix']);
  const out = [];
  run({ repo: dir, card: card(), config: config(t), log: (l) => out.push(l) });
  assert.ok(!out.some((l) => l.includes('dropped')), out.join('\n'));
  assert.equal(seen(t[1])[0].notes, true);
  assert.ok(existsSync(join(dir, 'README.md')));
});

test('REQ-RUN-71 the builder prompt tells the builder not to assign string literals to token, secret, password or api_key names', () => {
  const prompt = buildPrompt(card(), fixtureConfig(), null);
  assert.match(prompt, /Test fixtures must not assign string literals to names containing `token`, `secret`, `password` or `api_key`/);
});

test('REQ-RUN-70 an out-of-scope file the attempt deleted is restored from the base', () => {
  const { dir } = fixtureRepo({ ...BUGGY, 'README.md': 'base\n' });
  const t = tiers(['delete', 'delete'], ['fix']);
  const r = run({ repo: dir, card: card('kind: bug\nsize: S\npaths: src/**, test/**'), config: config(t) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(seen(t[1])[0].readme, 'base\n');
});
