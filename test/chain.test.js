import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from 'node:util';
import { availableMemory, chain, chainStateFile, chainSteps, memoryLine } from '../src/chain.js';
import { FIXTURE_TEST, commit, fixtureRepo, g, tmp } from './helpers.js';

const T0 = new Date(2026, 10, 25, 10, 0).getTime();
const MIN = 60_000;

/** A fake clock, its sleep, and the waits asked for. */
function clock(start = T0) {
  let at = start;
  const waits = [];
  return {
    now: () => at,
    sleep: async (ms) => {
      waits.push(ms);
      at += ms;
    },
    waits,
  };
}

/** A fake `keel run <id>`: each id answers from its own queue of results; the last one repeats. */
function runner(answers = {}) {
  const calls = [];
  const runCard = async (id) => {
    calls.push(id);
    const queue = answers[id] ?? [built(id)];
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { runCard, calls };
}
const built = (id, outcome = 'inReview') => ({ code: 0, signal: null, output: `keel: ${id}: ${outcome}\n` });
const failed = (id) => ({ code: 1, signal: null, output: `keel: ${id}: failed (gate: tests red)\n` });
const planLimit = (reset) => ({
  code: 3,
  signal: null,
  output: `keel: plan limit reached: claude week 96%${reset ? `; next reset ${new Date(reset).toString().slice(0, 21)}` : ''}\nkeel: (none): plan\n`,
});

function shipper(code = 0) {
  const calls = [];
  return { ship: async (repo, branches) => (calls.push(branches), { code }), calls };
}

function setup() {
  const dir = tmp('keel-chain-');
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  return { repo, stateFile: join(dir, 'state', 'chain', 'repo.json') };
}

const steps = (...items) => items.map((x) => (x === '--ship' ? { ship: true } : { id: x }));
const readState = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('REQ-CHAIN-1 builds in order and ships at each --ship', async () => {
  const { repo, stateFile } = setup();
  const { runCard, calls } = runner();
  const { ship, calls: shipped } = shipper();
  const lines = [];
  const c = clock();
  const result = await chain({
    repo,
    steps: steps('BUI-1', 'BUI-2', '--ship', 'BUI-3', '--ship', 'BUI-4'),
    runCard,
    ship,
    memory: () => 90,
    ...c,
    log: (l) => lines.push(l),
    stateFile,
  });
  assert.deepEqual(calls, ['BUI-1', 'BUI-2', 'BUI-3', 'BUI-4']);
  assert.deepEqual(shipped, [['keel/BUI-1', 'keel/BUI-2'], ['keel/BUI-3'], ['keel/BUI-4']]);
  assert.equal(result.exitCode, 0);
  const state = readState(stateFile);
  assert.deepEqual(state.built, ['BUI-1', 'BUI-2', 'BUI-3', 'BUI-4']);
  assert.deepEqual(state.remaining, []);
  assert.equal(state.done, true);
});

test('REQ-CHAIN-1 an empty --ship runs no ship, and a card that needs human review is not shipped', async () => {
  const { repo, stateFile } = setup();
  const { runCard } = runner({ 'BUI-2': [built('BUI-2', 'needsReview')] });
  const { ship, calls: shipped } = shipper();
  await chain({ repo, steps: steps('--ship', 'BUI-1', 'BUI-2'), runCard, ship, memory: () => 90, ...clock(), log: () => {}, stateFile });
  assert.deepEqual(shipped, [['keel/BUI-1']]);
  assert.deepEqual(readState(stateFile).built, ['BUI-1', 'BUI-2']);
});

test('REQ-CHAIN-1 a failed ship keeps its branches for the next ship and exits 1', async () => {
  const { repo, stateFile } = setup();
  const { runCard } = runner();
  const calls = [];
  let n = 0;
  const ship = async (r, branches) => (calls.push(branches), { code: n++ === 0 ? 1 : 0 });
  const result = await chain({
    repo,
    steps: steps('BUI-1', '--ship', 'BUI-2'),
    runCard,
    ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile,
  });
  assert.deepEqual(calls, [['keel/BUI-1'], ['keel/BUI-1', 'keel/BUI-2']]);
  assert.equal(result.exitCode, 1);
});

test('REQ-CHAIN-1 chainSteps keeps the order of ids and --ship and rejects anything else', () => {
  const parse = (args) =>
    parseArgs({ args, allowPositionals: true, tokens: true, options: { ship: { type: 'boolean' }, pr: { type: 'boolean' } } }).tokens;
  const { repo, steps: s } = chainSteps(parse(['chain', 'some/repo', 'BUI-1', '--ship', 'BUI-2']));
  assert.equal(repo, resolve('some/repo'));
  assert.deepEqual(s, steps('BUI-1', '--ship', 'BUI-2'));
  assert.throws(() => chainSteps(parse(['chain', 'r', 'BUI-1', '--pr'])), /--pr/);
  assert.throws(() => chainSteps(parse(['chain', 'r', 'card.md'])), /card\.md/);
  assert.throws(() => chainSteps(parse(['chain', 'r'])), /at least one/);
  assert.throws(() => chainSteps(parse(['chain'])), /repo/);
  assert.equal(chainStateFile('/x/games', '/s'), join('/s', 'chain', 'games.json'));
});

test('REQ-CHAIN-1 the CLI rejects a bad chain, and --ship outside chain, as usage errors', () => {
  const keel = (...args) =>
    spawnSync(process.execPath, [new URL('../bin/keel.js', import.meta.url).pathname, ...args], {
      encoding: 'utf8',
      env: { ...process.env, KEEL_STATE_DIR: tmp('keel-chain-cli-') },
    });
  const missing = keel('chain', join(tmp('keel-chain-cli-'), 'nope'), 'BUI-1');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /is not a directory/);
  const card = keel('chain', tmp('keel-chain-cli-'), 'card.md');
  assert.equal(card.status, 2);
  assert.match(card.stderr, /neither an issue ID/);
  const ship = keel('run', 'BUI-1', '--ship');
  assert.equal(ship.status, 2);
  assert.match(ship.stderr, /--ship is an option of chain only/);
  assert.match(keel('--help').stdout, /keel chain <repo>/);
});

test('REQ-CHAIN-1 card files build with keel run of the file, and its PASS line counts as built', async () => {
  const dir = tmp('keel-chain-cards-');
  const file = join(dir, 'card.md');
  writeFileSync(file, 'kind: feature\nsize: S\n\n# CARD-9: a card\n\nbody\n');
  const parse = (args) => parseArgs({ args, allowPositionals: true, tokens: true, options: { ship: { type: 'boolean' } } }).tokens;
  const { steps: s } = chainSteps(parse(['chain', dir, file, 'BUI-2']));
  assert.deepEqual(s, [{ id: 'CARD-9', card: file }, { id: 'BUI-2' }]);
  const { repo, stateFile } = setup();
  const targets = [];
  const outputs = {
    'CARD-9': {
      code: 0,
      signal: null,
      output: 'keel: gate passed on tier 0; branch keel/CARD-9\nkeel: PASS tier 0, attempt 1, branch keel/CARD-9\n',
    },
    'CARD-8': { code: 0, signal: null, output: 'keel: PASS tier 1, attempt 2, branch keel/CARD-8 — human review required\n' },
    'CARD-7': { code: 1, signal: null, output: 'keel: STOPPED (max-attempts) — worktree kept at /x\n' },
  };
  const runCard = async (id, target) => (targets.push([id, target]), outputs[id]);
  const { ship, calls: shipped } = shipper();
  const result = await chain({
    repo,
    steps: [
      { id: 'CARD-9', card: file },
      { id: 'CARD-8', card: '/c/8.md' },
      { id: 'CARD-7', card: '/c/7.md' },
    ],
    runCard,
    ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile,
  });
  assert.deepEqual(targets, [
    ['CARD-9', file],
    ['CARD-8', '/c/8.md'],
    ['CARD-7', '/c/7.md'],
  ]);
  assert.deepEqual(shipped, [['keel/CARD-9']]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(readState(stateFile).reasons, { 'CARD-7': 'STOPPED (max-attempts) — worktree kept at /x' });
});

test('REQ-CHAIN-1 keel chain builds card files with keel run, goes on after a failure, and ships the built branch', () => {
  const { dir: repo } = fixtureRepo();
  const work = tmp('keel-chain-e2e-');
  const script = join(work, 'worker.json');
  writeFileSync(script, JSON.stringify(['good', 'auth']));
  const fake = resolve('test/fake-worker.js');
  commit(
    repo,
    {
      'keel.json': JSON.stringify({
        checks: { test: FIXTURE_TEST },
        testCommand: FIXTURE_TEST,
        review: false,
        learnStart: false,
        maxAttempts: 1,
        tiers: [{ provider: 'exec', model: 'exec-fake', effort: 'low', command: ['node', fake, 'script', script], family: 'exec' }],
      }),
    },
    'chore: keel config',
  );
  const card = (id) => {
    const file = join(work, `${id}.md`);
    writeFileSync(
      file,
      `kind: bug\nsize: S\npaths: src/add.js, test/add.test.js\n\n# ${id}: fix add\n\n## Requirements\n\n- add shall sum.\n`,
    );
    return file;
  };
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const shipLog = join(work, 'ship.log');
  writeFileSync(join(bin, 'ship'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(shipLog)}\n`);
  chmodSync(join(bin, 'ship'), 0o755);
  const state = tmp('keel-chain-e2e-state-');
  const r = spawnSync(process.execPath, [resolve('bin/keel.js'), 'chain', repo, card('T-1'), card('T-2')], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEL_STATE_DIR: state, KEEL_MEMORY_LINE: '1', TMPDIR: tmp('keel-tmpdir-') },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(readFileSync(shipLog, 'utf8'), `${repo} keel/T-1\n`);
  const saved = readState(chainStateFile(repo, state));
  assert.deepEqual([saved.built, saved.failed, saved.remaining], [['T-1'], ['T-2'], []]);
  assert.match(saved.reasons['T-2'], /STOPPED \(auth\)/);
});

test('REQ-CHAIN-2 a card-file run that stops for quota waits for the ISO reset it names', async () => {
  const { repo, stateFile } = setup();
  const reset = new Date(T0 + 20 * MIN).toISOString();
  const quota = { code: 1, signal: null, output: `keel: STOPPED (quota) — no worktree kept: usage limit reached; resets at ${reset}\n` };
  const { runCard, calls } = runner({ 'CARD-1': [quota, built('CARD-1')] });
  const c = clock();
  await chain({
    repo,
    steps: [{ id: 'CARD-1', card: '/c/1.md' }],
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...c,
    log: () => {},
    stateFile,
  });
  assert.deepEqual(calls, ['CARD-1', 'CARD-1']);
  assert.deepEqual(c.waits, [22 * MIN]);
});

test('REQ-CHAIN-2 a quota deferral waits for the reset and retries', async () => {
  const { repo, stateFile } = setup();
  const reset = T0 + 90 * MIN;
  const { runCard, calls } = runner({ 'BUI-1': [planLimit(reset), built('BUI-1')] });
  const c = clock();
  const result = await chain({
    repo,
    steps: steps('BUI-1', 'BUI-2'),
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...c,
    log: () => {},
    stateFile,
  });
  assert.deepEqual(calls, ['BUI-1', 'BUI-1', 'BUI-2']);
  assert.deepEqual(c.waits, [92 * MIN]);
  assert.equal(result.exitCode, 0);
});

test('REQ-CHAIN-2 a worker quota stop with no reset waits 30 minutes; after 4 waits the chain stops', async () => {
  const { repo, stateFile } = setup();
  const quota = { code: 3, signal: null, output: 'keel: BUI-1: deferred (quota: out of usage)\n' };
  const { runCard, calls } = runner({ 'BUI-1': [quota] });
  const { ship, calls: shipped } = shipper();
  const c = clock();
  const result = await chain({
    repo,
    steps: steps('BUI-0', 'BUI-1', 'BUI-2'),
    runCard,
    ship,
    memory: () => 90,
    ...c,
    log: () => {},
    stateFile,
  });
  assert.deepEqual(calls, ['BUI-0', 'BUI-1', 'BUI-1', 'BUI-1', 'BUI-1', 'BUI-1']);
  assert.deepEqual(c.waits, [30 * MIN, 30 * MIN, 30 * MIN, 30 * MIN]);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(shipped, [['keel/BUI-0']], 'a stop ships what was built');
  const state = readState(stateFile);
  assert.deepEqual(state.remaining, ['BUI-1', 'BUI-2']);
  assert.deepEqual(state.failed, []);
  assert.equal(state.done, false);
});

test('REQ-CHAIN-2 a reset already past runs the card again at once', async () => {
  const { repo, stateFile } = setup();
  const { runCard } = runner({ 'BUI-1': [planLimit(T0 - 60 * MIN), built('BUI-1')] });
  const c = clock();
  await chain({ repo, steps: steps('BUI-1'), runCard, ship: shipper().ship, memory: () => 90, ...c, log: () => {}, stateFile });
  assert.deepEqual(c.waits, []);
});

test('REQ-CHAIN-3 low memory delays the start instead of skipping the card', async () => {
  const { repo, stateFile } = setup();
  const levels = [30, 38, 44, 46];
  const { runCard, calls } = runner();
  const c = clock();
  const memory = () => (levels.length > 1 ? levels.shift() : levels[0]);
  const result = await chain({
    repo,
    steps: steps('BUI-1'),
    runCard,
    ship: shipper().ship,
    memory,
    killLine: 40,
    ...c,
    log: () => {},
    stateFile,
  });
  assert.deepEqual(calls, ['BUI-1']);
  assert.equal(c.waits.length, 3, 'waits until 45 %, not only until the 40 % line');
  assert.equal(result.exitCode, 0);
});

test('REQ-CHAIN-3 memory between the line and line + 5 % starts at once', async () => {
  const { repo, stateFile } = setup();
  const { runCard, calls } = runner();
  const c = clock();
  await chain({
    repo,
    steps: steps('BUI-1'),
    runCard,
    ship: shipper().ship,
    memory: () => 42,
    killLine: 40,
    ...c,
    log: () => {},
    stateFile,
  });
  assert.deepEqual(calls, ['BUI-1']);
  assert.deepEqual(c.waits, []);
});

test('REQ-CHAIN-3 memory under the line for 2 hours stops the chain with the card still to build', async () => {
  const { repo, stateFile } = setup();
  const { runCard, calls } = runner();
  const c = clock();
  const lines = [];
  const result = await chain({
    repo,
    steps: steps('BUI-1', 'BUI-2'),
    runCard,
    ship: shipper().ship,
    memory: () => 20,
    killLine: 40,
    ...c,
    log: (l) => lines.push(l),
    stateFile,
  });
  assert.deepEqual(calls, []);
  assert.equal(result.exitCode, 3);
  assert.ok(c.now() - T0 >= 120 * MIN && c.now() - T0 < 125 * MIN);
  assert.deepEqual(readState(stateFile).remaining, ['BUI-1', 'BUI-2']);
  assert.ok(lines.some((l) => /memory/.test(l)));
});

test('REQ-CHAIN-3 memory that cannot be read does not hold a run', async () => {
  const { repo, stateFile } = setup();
  const levels = [null, 20, null];
  const { runCard, calls } = runner({ 'BUI-1': [built('BUI-1')] });
  const c = clock();
  const memory = () => levels.shift();
  await chain({
    repo,
    steps: steps('BUI-1', 'BUI-2'),
    runCard,
    ship: shipper().ship,
    memory,
    killLine: 40,
    ...c,
    log: () => {},
    stateFile,
  });
  assert.deepEqual(calls, ['BUI-1', 'BUI-2'], 'BUI-1 starts at once; BUI-2 starts when the reading is gone');
  assert.deepEqual(c.waits, [10_000]);
});

test('REQ-CHAIN-3 availableMemory reads macOS and Linux, and null elsewhere', () => {
  assert.equal(
    availableMemory('darwin', () => ({ status: 0, stdout: '57\n' })),
    57,
  );
  assert.equal(
    availableMemory('darwin', () => ({ status: 1, stdout: '' })),
    null,
  );
  const meminfo = 'MemTotal:       1000 kB\nMemFree:  10 kB\nMemAvailable:    333 kB\n';
  assert.equal(
    availableMemory('linux', null, () => meminfo),
    33,
  );
  assert.equal(availableMemory('win32'), null);
});

test('REQ-CHAIN-3 memoryLine reads KEEL_MEMORY_LINE, default 40, and rejects a bad value', () => {
  assert.equal(memoryLine({}), 40);
  assert.equal(memoryLine({ KEEL_MEMORY_LINE: '35' }), 35);
  assert.equal(memoryLine({ MEMWATCH_MIN_AVAILABLE: '45' }), 45, "the memory watchdog's own line");
  assert.equal(memoryLine({ KEEL_MEMORY_LINE: '30', MEMWATCH_MIN_AVAILABLE: '45' }), 30);
  assert.throws(() => memoryLine({ MEMWATCH_MIN_AVAILABLE: '0' }), /MEMWATCH_MIN_AVAILABLE/);
  assert.throws(() => memoryLine({ KEEL_MEMORY_LINE: 'x' }), /KEEL_MEMORY_LINE/);
  assert.throws(() => memoryLine({ KEEL_MEMORY_LINE: '100' }), /KEEL_MEMORY_LINE/);
});

/** A repo with a bare origin, and the leftover worktree a killed `keel run` of `id` left, with uncommitted work. */
function killedRun(id) {
  const { dir: repo } = fixtureRepo();
  const origin = tmp('keel-origin-');
  g(origin, 'init', '-q', '--bare');
  g(repo, 'remote', 'add', 'origin', origin);
  g(repo, 'push', '-q', 'origin', 'main');
  const state = tmp('keel-chain-state-');
  const key = `${basename(repo)}-${createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8)}-${id}`;
  const wt = join(state, 'worktrees', key);
  g(repo, 'worktree', 'add', '-q', '-b', `keel/${id}`, wt);
  writeFileSync(join(wt, 'half-done.js'), 'export const half = 1;\n');
  return { repo, origin, state, wt, lock: join(state, 'locks', key) };
}

const refused = (wt) => ({
  code: 1,
  signal: null,
  output: `Error: worktree exists: ${wt} — inspect it, then: git worktree remove --force ${wt}\n`,
});

test("REQ-CHAIN-4 a killed run's worktree is saved to wip/ and the card runs again", async (t) => {
  const id = 'BUI-4';
  const { repo, origin, state, wt } = killedRun(id);
  const before = process.env.KEEL_STATE_DIR;
  process.env.KEEL_STATE_DIR = state;
  t.after(() => (before === undefined ? delete process.env.KEEL_STATE_DIR : (process.env.KEEL_STATE_DIR = before)));
  const { runCard, calls } = runner({ [id]: [refused(wt), built(id)] });
  const result = await chain({
    repo,
    steps: steps(id),
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile: chainStateFile(repo, state),
  });
  assert.deepEqual(calls, [id, id]);
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(wt), false, 'the leftover worktree is removed');
  const wip = g(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/wip/');
  assert.match(wip, /^wip\/BUI-4-20261125-1000$/);
  assert.equal(g(origin, 'show', `${wip}:half-done.js`), 'export const half = 1;');
  assert.equal(g(repo, 'status', '--porcelain'), '', 'the primary checkout is untouched');
});

test('REQ-CHAIN-4 two recoveries in one minute save to two wip refs, and the third run builds', async (t) => {
  const id = 'BUI-9';
  const { repo, origin, state, wt } = killedRun(id);
  const before = process.env.KEEL_STATE_DIR;
  process.env.KEEL_STATE_DIR = state;
  t.after(() => (before === undefined ? delete process.env.KEEL_STATE_DIR : (process.env.KEEL_STATE_DIR = before)));
  const calls = [];
  // The rerun is killed too: it built a new worktree from base, with other work, in the same minute.
  const runCard = async (cardId) => {
    calls.push(cardId);
    if (calls.length === 2) {
      g(repo, 'worktree', 'add', '-q', '-b', `keel/${id}`, wt);
      writeFileSync(join(wt, 'second.js'), 'export const second = 2;\n');
      return refused(wt);
    }
    return calls.length === 1 ? refused(wt) : built(id);
  };
  const result = await chain({
    repo,
    steps: steps(id),
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile: chainStateFile(repo, state),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [id, id, id]);
  const refs = g(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/wip/').split('\n');
  assert.deepEqual(refs, ['wip/BUI-9-20261125-1000', 'wip/BUI-9-20261125-1000-2']);
  assert.equal(g(origin, 'show', `${refs[0]}:half-done.js`), 'export const half = 1;');
  assert.equal(g(origin, 'show', `${refs[1]}:second.js`), 'export const second = 2;');
});

test('REQ-CHAIN-4 a worktree a worker moved off keel/<id> is left as it is, and its branch is kept', async (t) => {
  const id = 'BUI-10';
  const { repo, origin, state, wt } = killedRun(id);
  g(wt, 'add', '-A');
  g(wt, 'commit', '-q', '-m', 'work on keel branch');
  const work = g(wt, 'rev-parse', 'HEAD');
  g(wt, 'checkout', '-q', '-b', 'user-work', 'main');
  const before = process.env.KEEL_STATE_DIR;
  process.env.KEEL_STATE_DIR = state;
  t.after(() => (before === undefined ? delete process.env.KEEL_STATE_DIR : (process.env.KEEL_STATE_DIR = before)));
  const { runCard, calls } = runner({ [id]: [refused(wt)] });
  const lines = [];
  const result = await chain({
    repo,
    steps: steps(id),
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...clock(),
    log: (l) => lines.push(l),
    stateFile: chainStateFile(repo, state),
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, [id]);
  assert.equal(existsSync(wt), true);
  assert.equal(g(repo, 'rev-parse', `keel/${id}`), work, 'the keel branch and its commit are kept');
  assert.equal(g(origin, 'for-each-ref', 'refs/heads/wip/'), '');
  assert.ok(lines.some((l) => l.includes('is on user-work, not keel/BUI-10')));
});

test('REQ-CHAIN-4 a run killed by a signal runs again; after 3 recoveries the card fails', async (t) => {
  const id = 'BUI-5';
  const { repo, state } = killedRun(id);
  const before = process.env.KEEL_STATE_DIR;
  process.env.KEEL_STATE_DIR = state;
  t.after(() => (before === undefined ? delete process.env.KEEL_STATE_DIR : (process.env.KEEL_STATE_DIR = before)));
  const { runCard, calls } = runner({ [id]: [{ code: null, signal: 'SIGKILL', output: '' }] });
  const result = await chain({
    repo,
    steps: steps(id, 'BUI-6'),
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile: chainStateFile(repo, state),
  });
  assert.deepEqual(calls, [id, id, id, id, 'BUI-6']);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(readState(chainStateFile(repo, state)).failed, [id]);
});

test('REQ-CHAIN-4 a worktree a live run holds is left alone and the card fails', async (t) => {
  const id = 'BUI-7';
  const { repo, state, wt, lock } = killedRun(id);
  mkdirSync(join(state, 'locks'), { recursive: true });
  writeFileSync(`${lock}.run-${process.pid}-1`, '');
  const before = process.env.KEEL_STATE_DIR;
  process.env.KEEL_STATE_DIR = state;
  t.after(() => (before === undefined ? delete process.env.KEEL_STATE_DIR : (process.env.KEEL_STATE_DIR = before)));
  const { runCard, calls } = runner({ [id]: [refused(wt)] });
  const result = await chain({
    repo,
    steps: steps(id),
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile: chainStateFile(repo, state),
  });
  assert.deepEqual(calls, [id]);
  assert.equal(existsSync(join(wt, 'half-done.js')), true);
  assert.equal(result.exitCode, 1);
});

test('REQ-CHAIN-4 a worktree whose work cannot be pushed is kept and the card fails', async (t) => {
  const id = 'BUI-8';
  const { repo, state, wt } = killedRun(id);
  g(repo, 'remote', 'set-url', 'origin', join(state, 'no-such-origin'));
  const before = process.env.KEEL_STATE_DIR;
  process.env.KEEL_STATE_DIR = state;
  t.after(() => (before === undefined ? delete process.env.KEEL_STATE_DIR : (process.env.KEEL_STATE_DIR = before)));
  const { runCard, calls } = runner({ [id]: [refused(wt)] });
  const lines = [];
  const result = await chain({
    repo,
    steps: steps(id),
    runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...clock(),
    log: (l) => lines.push(l),
    stateFile: chainStateFile(repo, state),
  });
  assert.deepEqual(calls, [id]);
  assert.equal(existsSync(join(wt, 'half-done.js')), true, 'work that exists nowhere else is never removed');
  assert.equal(result.exitCode, 1);
  assert.ok(lines.some((l) => /could not push/.test(l)));
});

test('REQ-CHAIN-5 another failure moves on to the next card', async () => {
  const { repo, stateFile } = setup();
  const { runCard, calls } = runner({ 'BUI-1': [failed('BUI-1')] });
  const { ship, calls: shipped } = shipper();
  const lines = [];
  const c = clock();
  const result = await chain({
    repo,
    steps: steps('BUI-1', 'BUI-2'),
    runCard,
    ship,
    memory: () => 90,
    ...c,
    log: (l) => lines.push(l),
    stateFile,
  });
  assert.deepEqual(calls, ['BUI-1', 'BUI-2']);
  assert.deepEqual(c.waits, []);
  assert.deepEqual(shipped, [['keel/BUI-2']]);
  assert.equal(result.exitCode, 1);
  const state = readState(stateFile);
  assert.deepEqual(state.built, ['BUI-2']);
  assert.deepEqual(state.failed, ['BUI-1']);
  assert.deepEqual(state.reasons, { 'BUI-1': 'failed (gate: tests red)' });
  assert.ok(lines.some((l) => l.includes('BUI-1') && l.includes('failed (gate: tests red)')));
});

test('REQ-CHAIN-6 a restart resumes from the state file', async () => {
  const { repo, stateFile } = setup();
  const list = steps('BUI-1', '--ship', 'BUI-2', 'BUI-3');
  const first = runner({ 'BUI-2': [failed('BUI-2')] });
  let low = false;
  const memory = () => (low ? 10 : 90);
  // The first chain builds BUI-1, fails BUI-2, then stops on memory before BUI-3.
  const wrapped = async (id) => {
    const r = await first.runCard(id);
    if (id === 'BUI-2') low = true;
    return r;
  };
  const stopped = await chain({ repo, steps: list, runCard: wrapped, ship: shipper().ship, memory, ...clock(), log: () => {}, stateFile });
  assert.equal(stopped.exitCode, 3);
  const saved = readState(stateFile);
  assert.deepEqual(saved.built, ['BUI-1']);
  assert.deepEqual(saved.failed, ['BUI-2']);
  assert.deepEqual(saved.remaining, ['BUI-3']);
  low = false;
  const second = runner();
  const { ship, calls: shipped } = shipper();
  const resumed = await chain({ repo, steps: list, runCard: second.runCard, ship, memory, ...clock(), log: () => {}, stateFile });
  assert.deepEqual(second.calls, ['BUI-3'], 'a built or failed card is not built again');
  assert.deepEqual(shipped, [['keel/BUI-3']]);
  assert.equal(resumed.exitCode, 1, 'the earlier failure still counts');
  assert.deepEqual(readState(stateFile).built, ['BUI-1', 'BUI-3']);
});

test('REQ-CHAIN-6 after a finished chain a built card is still not rebuilt, and a failed one is tried again', async () => {
  const { repo, stateFile } = setup();
  const run = (r) =>
    chain({
      repo,
      steps: steps('BUI-1', 'BUI-2'),
      runCard: r.runCard,
      ship: shipper().ship,
      memory: () => 90,
      ...clock(),
      log: () => {},
      stateFile,
    });
  const one = runner({ 'BUI-2': [failed('BUI-2')] });
  assert.equal((await run(one)).exitCode, 1);
  assert.equal(readState(stateFile).done, true);
  const two = runner();
  assert.equal((await run(two)).exitCode, 0);
  assert.deepEqual(two.calls, ['BUI-2']);
  assert.deepEqual(readState(stateFile).built, ['BUI-1', 'BUI-2']);
});

test('REQ-CHAIN-6 a state file of only built, failed and remaining cards is resumed', async () => {
  const { repo, stateFile } = setup();
  mkdirSync(join(stateFile, '..'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ built: ['BUI-1'], failed: ['BUI-2'], remaining: ['BUI-3'] }));
  const r = runner();
  const { ship, calls: shipped } = shipper();
  await chain({
    repo,
    steps: steps('BUI-1', 'BUI-2', 'BUI-3'),
    runCard: r.runCard,
    ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile,
  });
  assert.deepEqual(r.calls, ['BUI-3']);
  assert.deepEqual(shipped, [['keel/BUI-3']]);
  const state = readState(stateFile);
  assert.deepEqual([state.built, state.failed, state.remaining], [['BUI-1', 'BUI-3'], ['BUI-2'], []]);
});

test('REQ-CHAIN-6 the state of another repo of the same name is not used', async () => {
  const { repo, stateFile } = setup();
  mkdirSync(join(stateFile, '..'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ repo: '/elsewhere/repo', built: ['BUI-1'], failed: [], remaining: ['BUI-2'] }));
  const r = runner();
  await chain({
    repo,
    steps: steps('BUI-1'),
    runCard: r.runCard,
    ship: shipper().ship,
    memory: () => 90,
    ...clock(),
    log: () => {},
    stateFile,
  });
  assert.deepEqual(r.calls, ['BUI-1']);
});

test('REQ-CHAIN-6 a state file that is not valid JSON stops the chain with its path', async () => {
  const { repo, stateFile } = setup();
  mkdirSync(join(stateFile, '..'), { recursive: true });
  writeFileSync(stateFile, '{ not json');
  const { runCard } = runner();
  await assert.rejects(
    chain({ repo, steps: steps('BUI-1'), runCard, ship: shipper().ship, memory: () => 90, ...clock(), log: () => {}, stateFile }),
    (e) => e.message.includes(stateFile),
  );
});
