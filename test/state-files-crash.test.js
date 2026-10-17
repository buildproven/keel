import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { appendAttempt, readJsonl, readLedger } from '../src/ledger.js';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { run } from '../src/run.js';
import { acquireRunLock } from '../src/run-lock.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const good = { provider: 'exec', family: 'exec', model: 'm-good', effort: 'low', command: ['node', FAKE, 'good'] };
const card = () => parseCard('# T-5: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

/** The lock dir run() uses for (repo, card), as run.js names it. */
const lockDir = (repo, id) =>
  join(
    process.env.KEEL_STATE_DIR,
    'locks',
    `${basename(repo)}-${createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8)}-${id}`,
  );

test('REQ-RUN-10 a lock entry of a dead run, or one naming no process id, is a crash leftover: the next run removes it and runs', () => {
  for (const owner of ['2147483646', 'x', '']) {
    const { dir } = fixtureRepo();
    mkdirSync(join(process.env.KEEL_STATE_DIR, 'locks'), { recursive: true });
    writeFileSync(`${lockDir(dir, 'T-5')}.run-${owner}`, '');
    const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [good], learnStart: false, maxAttempts: 1 }) });
    assert.equal(r.pass, true, `owner ${JSON.stringify(owner)}: ${r.failure}`);
    assert.equal(existsSync(`${lockDir(dir, 'T-5')}.run-${owner}`), false, 'the leftover is gone');
  }
});

test('REQ-RUN-10 a lock of the earlier layout held by a live run still locks the card; a dead one does not', () => {
  const { dir } = fixtureRepo();
  mkdirSync(lockDir(dir, 'T-5'), { recursive: true });
  writeFileSync(join(lockDir(dir, 'T-5'), 'pid'), String(process.ppid));
  const config = fixtureConfig({ tiers: [good], learnStart: false, maxAttempts: 1 });
  assert.throws(() => run({ repo: dir, card: card(), config }), /locked by another keel run in progress/);
  writeFileSync(join(lockDir(dir, 'T-5'), 'pid'), '2147483646');
  assert.equal(run({ repo: dir, card: card(), config }).pass, true);
});

test('REQ-RUN-10 while a run holds the lock, an older Keel cannot take it: <lock>/pid names the live holder until release', () => {
  const lock = join(tmp('keel-locks-'), 'repo-abc12345-T-1');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), '2147483646'); // an older Keel run that died
  const release = acquireRunLock(lock);
  assert.throws(() => mkdirSync(lock), /EEXIST/, 'an older Keel takes the lock with mkdir');
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid));
  release();
  assert.equal(existsSync(lock), false);
});

test('REQ-RUN-10 a lock entry of a live run makes a second run fail at once with the locked error', () => {
  const { dir } = fixtureRepo();
  mkdirSync(join(process.env.KEEL_STATE_DIR, 'locks'), { recursive: true });
  writeFileSync(`${lockDir(dir, 'T-5')}.run-${process.ppid}`, ''); // the test runner's parent is alive
  assert.throws(
    () => run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [good], learnStart: false, maxAttempts: 1 }) }),
    /locked by another keel run in progress \(pid \d+\)/,
  );
  assert.ok(existsSync(`${lockDir(dir, 'T-5')}.run-${process.ppid}`), 'a live run keeps its lock');
});

test('REQ-LED-1 a cut-off last ledger line (a killed write) is skipped, and the row appended after it is still read', () => {
  appendAttempt({ card: 'T-1', attempt: 1, workerStatus: 'ok', gatePass: true, usage: null });
  appendFileSync(join(process.env.KEEL_STATE_DIR, 'ledger.jsonl'), '{"card":"T-2","attem');
  assert.deepEqual(
    readLedger().map((r) => r.card),
    ['T-1'],
  );
  appendAttempt({ card: 'T-3', attempt: 1, workerStatus: 'ok', gatePass: true, usage: null });
  assert.deepEqual(
    readLedger().map((r) => r.card),
    ['T-1', 'T-3'],
  );
});

test('REQ-LED-1 a bad ledger line never stops a reader: it is skipped, and a row glued after a cut-off write is kept', () => {
  appendAttempt({ card: 'T-1', attempt: 1, workerStatus: 'ok', gatePass: true, usage: null });
  appendFileSync(join(process.env.KEEL_STATE_DIR, 'ledger.jsonl'), 'not json\n{"card":"T-2","detail":{"x');
  appendAttempt({ card: 'T-3', attempt: 1, workerStatus: 'ok', gatePass: true, usage: null });
  appendAttempt({ card: 'T-4', attempt: 1, workerStatus: 'ok', gatePass: true, usage: null });
  assert.deepEqual(
    readLedger().map((r) => r.card),
    ['T-1', 'T-3', 'T-4'],
  );
});

test('REQ-LED-1 two processes appending to one JSONL file at once lose no row', async () => {
  const file = join(process.env.KEEL_STATE_DIR, 'shared.jsonl');
  appendFileSync(file, '{"w":"crash","i":'); // a crash leftover the appenders must not destroy
  const ledger = new URL('../src/ledger.js', import.meta.url).href;
  const writer = (w) =>
    new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { appendJsonl } from '${ledger}'; for (let i = 0; i < 300; i++) appendJsonl(process.argv[1], { w: '${w}', i, pad: 'x'.repeat(200) });`,
          file,
        ],
        { stdio: 'inherit' },
      );
      child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`writer ${w} exited ${code}`))));
    });
  await Promise.all([writer('a'), writer('b')]);
  const rows = readJsonl(file);
  for (const w of ['a', 'b'])
    assert.deepEqual(
      rows.filter((r) => r.w === w).map((r) => r.i),
      Array.from({ length: 300 }, (_, i) => i),
      `every row of writer ${w}, in order`,
    );
  assert.ok(readFileSync(file, 'utf8').startsWith('{"w":"crash","i":'), 'nothing was truncated or rewritten');
});

test('REQ-LINEAR-6 a cut-off last poll-ledger line does not stop the loop, and the next record is still read', () => {
  const repo = tmp('keel-repo-');
  recordPollAttempt(repo, { issue: 'BUI-1', outcome: 'found', detail: [{ kind: 'bug', title: 'one', detail: 'a:1' }] });
  appendFileSync(join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl'), '{"repo":"x","iss');
  recordPollAttempt(repo, { issue: 'BUI-2', outcome: 'found', detail: [{ kind: 'bug', title: 'two', detail: 'b:1' }] });
  assert.deepEqual(
    pendingFollowUps(repo).map((f) => f.title),
    ['one', 'two'],
  );
  assert.ok(readFileSync(join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl'), 'utf8').endsWith('\n'));
});
