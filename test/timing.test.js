import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { doctor } from '../src/doctor.js';
import { gate } from '../src/gate.js';
import { appendJsonl } from '../src/ledger.js';
import { duplicateWork, expandCommand, fmtMs, improveLines, repoIdOf, serialReason, slowestChecks, timingLine } from '../src/timing.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp, write } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;
const card = parseCard('# T-1: test card\nkind: bug\nsize: S\n');

test('REQ-GATE-45 each command stage records its wall time and the gate prints one timing line', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const r = gate({ repo: dir, base, card, config: fixtureConfig({ checks: { lint: 'sleep 0.2', test: fixtureConfig().testCommand } }) });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const lint = r.results.find((x) => x.name === 'lint');
  assert.ok(lint.ms >= 200, `lint ms ${lint.ms}`);
  assert.equal(typeof r.results.find((x) => x.name === 'red-proof').ms, 'number');
  assert.match(r.timing, /^timing lint \d+s · test \d+s · red-proof \d+s · total \d+s$/);
});

test('REQ-GATE-45 durations read as seconds under 90 s and minutes with seconds above', () => {
  assert.equal(fmtMs(4_000), '4s');
  assert.equal(fmtMs(192_000), '3m12s');
  assert.equal(timingLine([{ name: 'locked', pass: true, problems: [] }]), null);
});

test('REQ-GATE-46 a gate with receipts appends its stage times per repository beside them', () => {
  const state = tmp('keel-state-');
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  gate({ repo: dir, base, card, config: fixtureConfig(), receiptDir: join(state, 'receipts') });
  const rows = readFileSync(join(state, 'gate-times.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo, repoIdOf(dir));
  assert.equal(rows[0].card, 'T-1');
  assert.equal(rows[0].pass, true);
  assert.deepEqual(Object.keys(rows[0].checks), ['test', 'red-proof']);
});

test('REQ-GATE-46 IMPROVE names a stage over its absolute limit with a concrete fix', () => {
  const [line] = improveLines({ test: 192_000, lint: 4_000 }, []);
  assert.match(line, /^IMPROVE: test took 3m12s \(over the 2m00s limit\): run tests in parallel \(pytest -n auto/);
  assert.equal(improveLines({ test: 192_000, lint: 4_000 }, []).length, 1);
  assert.deepEqual(improveLines({ review: 200_000 }, []), [], 'the review limit is higher than a command check');
});

test('REQ-GATE-46 IMPROVE names a stage 1.5x slower than its trailing median of passing gates, not noise', () => {
  const past = [40_000, 42_000, 38_000].map((ms) => ({ pass: true, checks: { test: ms } }));
  const failing = { pass: false, checks: { test: 1_000 } };
  assert.match(improveLines({ test: 90_000 }, [...past, failing])[0], /median 40s over 3 gates/);
  assert.deepEqual(improveLines({ test: 55_000 }, past), [], 'under 1.5x');
  const small = [2_000, 2_000, 2_000].map((ms) => ({ pass: true, checks: { lint: ms } }));
  assert.deepEqual(improveLines({ lint: 10_000 }, small), [], '5x but only 8 s more is noise');
  assert.deepEqual(improveLines({ test: 90_000 }, past.slice(0, 2)), [], 'fewer than 3 earlier gates');
});

test('REQ-CLI-13 doctor times each command and warns when a slow pytest suite runs on one core', () => {
  const dir = tmp('keel-py-');
  write(dir, { 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' });
  assert.match(serialReason('python3 -m pytest tests/ -q', dir), /pytest runs on one core: add pytest-xdist and `-n auto`/);
  assert.equal(serialReason('python3 -m pytest tests/ -q -n auto', dir), null);
  write(dir, { 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-n 4"\n' });
  assert.equal(serialReason('python3 -m pytest tests/', dir), null, 'xdist set in addopts');
  assert.match(serialReason('jest --runInBand', dir), /runs in band/);
  assert.equal(serialReason('node --test test/', dir), null, 'node --test runs files in parallel by default');
  const { dir: repo, base } = fixtureRepo();
  const rows = doctor({ repo, base, config: fixtureConfig({ checks: { lint: 'true' }, testCommand: 'true' }) });
  assert.ok(rows.every((r) => r.kind === 'advice' || typeof r.ms === 'number'));
});

test('REQ-CLI-13 doctor warns, without failing, when two checks run the same command through npm scripts', () => {
  const dir = tmp('keel-npm-');
  write(dir, { 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'npm run lint && node --test' } }) });
  assert.deepEqual(expandCommand('npm test', dir), ['eslint .', 'node --test']);
  assert.deepEqual(duplicateWork({ lint: 'npm run lint', test: 'npm test' }, dir), [{ part: 'eslint .', names: ['lint', 'test'] }]);
  const { dir: repo, base } = fixtureRepo({
    'package.json': JSON.stringify({ type: 'module', scripts: { lint: 'true', test: 'npm run lint && true' } }),
  });
  const rows = doctor({
    repo,
    base,
    config: fixtureConfig({ checks: { lint: 'npm run lint', test: 'npm test' }, testCommand: 'npm test' }),
  });
  const advice = rows.filter((r) => r.kind === 'advice');
  assert.deepEqual(
    advice.map((r) => r.output),
    ['lint and test both run "true"; run it in one check only'],
  );
  assert.ok(advice.every((r) => r.pass));
});

test('REQ-LED-18 keel report shows the slowest check per repo over its last passing gates', () => {
  const rows = [
    { repo: '/a', pass: true, checks: { lint: 3_000, test: 200_000 } },
    { repo: '/a', pass: true, checks: { lint: 4_000, test: 180_000 } },
    { repo: '/a', pass: false, checks: { lint: 900_000 } },
    { repo: '/b', pass: true, checks: { lint: 5_000, review: 60_000 } },
  ];
  assert.deepEqual(slowestChecks(rows), [
    { repo: '/a', check: 'test', medianMs: 190_000, n: 2, gates: 2 },
    { repo: '/b', check: 'review', medianMs: 60_000, n: 1, gates: 1 },
  ]);
  const state = tmp('keel-state-');
  for (const r of rows) appendJsonl(join(state, 'gate-times.jsonl'), r);
  const out = spawnSync(process.execPath, [BIN, 'report'], { encoding: 'utf8', env: { ...process.env, KEEL_STATE_DIR: state } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(
    out.stdout,
    /slowest check per repo \(median, last passing gates\):\n {2}\/a: test 3m10s \(2 of 2 gates\)\n {2}\/b: review 60s/,
  );
});

test('REQ-CLI-13 a package.json that is not JSON leaves commands unexpanded; advice never throws', () => {
  const dir = tmp('keel-badpkg-');
  write(dir, { 'package.json': '{ not json' });
  assert.deepEqual(expandCommand('npm test && ruff check .', dir), ['npm test', 'ruff check .']);
  assert.deepEqual(expandCommand('python3 -m pytest', dir), ['python3 -m pytest']);
});
