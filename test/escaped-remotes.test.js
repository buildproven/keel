import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { escapedDefects, formatEscaped } from '../src/escaped.js';
import { value } from '../src/value.js';
import { commit, FIXED_SRC, fixtureRepo, g, REGRESSION_TEST, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const accepted = (over) => ({
  run: over.card,
  attempt: 1,
  tier: 0,
  attemptPass: true,
  cost: 0.1,
  at: new Date().toISOString(),
  ...over,
});

function twoRemoteRepo({ mergeOnDev }) {
  const { dir, base } = fixtureRepo();
  g(dir, 'remote', 'add', 'origin', 'https://example.invalid/origin.git');
  g(dir, 'checkout', '-q', '-b', 'origin-main', 'main');
  const originTip = commit(dir, { 'src/origin.js': 'export const originOnly = true;\n' }, 'feat: origin only');
  g(dir, 'update-ref', 'refs/remotes/origin/main', originTip);
  g(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  g(dir, 'remote', 'add', 'dev', 'https://example.invalid/dev.git');

  g(dir, 'checkout', '-q', '-b', 'keel/BUI-1477', 'main');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', '-b', 'dev-main', 'main');
  if (mergeOnDev) {
    commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'BUI-1477: add sums (#1)');
    const tip = commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }, 'fix: add coerces strings');
    g(dir, 'update-ref', 'refs/remotes/dev/main', tip);
  }
  return { dir, base, head };
}

test("REQ-LED-21 a merge only on a second remote's main is measured", () => {
  const { dir, base, head } = twoRemoteRepo({ mergeOnDev: true });
  const rows = [accepted({ card: 'BUI-1477', repo: dir, base, head })];

  const escaped = escapedDefects(rows);
  assert.equal(escaped.notFound.length, 0);
  assert.deepEqual(
    escaped.merged[0].candidates.map((candidate) => candidate.subject),
    ['fix: add coerces strings'],
  );
  const measured = value(rows, { prsFor: () => [] });
  assert.deepEqual(measured.keel, { merged: 1, followed: 1 });
  assert.deepEqual(measured.other, { changes: 3, followed: 0 }, 'the value baseline includes origin and the second remote');
});

test('REQ-LED-21 uses checked-out HEAD when origin/HEAD is missing', () => {
  const { dir, base } = fixtureRepo();
  g(dir, 'remote', 'add', 'origin', 'https://example.invalid/origin.git');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-1477');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'BUI-1477: add sums (#1)');
  commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }, 'fix: add coerces strings');

  const result = escapedDefects([accepted({ card: 'BUI-1477', repo: dir, base, head })]);

  assert.equal(result.notFound.length, 0);
  assert.deepEqual(
    result.merged[0].candidates.map((candidate) => candidate.subject),
    ['fix: add coerces strings'],
  );
});

test('REQ-LED-21 a merge on no remote stays not found and names the remotes', () => {
  const { dir, base, head } = twoRemoteRepo({ mergeOnDev: false });
  const result = escapedDefects([accepted({ card: 'BUI-1477', repo: dir, base, head })]);

  assert.equal(result.merged.length, 0);
  assert.match(formatEscaped(result), /^BUI-1477: not on the default branch \(looked at remotes: origin, dev\)/m);
});

test('REQ-LED-21 not-found output names HEAD instead of an unavailable origin default', () => {
  const { dir, base } = fixtureRepo();
  g(dir, 'remote', 'add', 'origin', 'https://example.invalid/origin.git');
  g(dir, 'remote', 'add', 'dev', 'https://example.invalid/dev.git');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-1477');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', 'main');

  const result = escapedDefects([accepted({ card: 'BUI-1477', repo: dir, base, head })]);

  assert.match(formatEscaped(result), /^BUI-1477: not on the default branch \(looked at refs: HEAD, dev\)/m);
});

test('REQ-LED-21 not-found output has no empty remote name when origin is absent', () => {
  const { dir, base } = fixtureRepo();
  g(dir, 'remote', 'add', 'dev', 'https://example.invalid/dev.git');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-1477');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', 'main');

  const result = escapedDefects([accepted({ card: 'BUI-1477', repo: dir, base, head })]);

  assert.match(formatEscaped(result), /^BUI-1477: not on the default branch \(looked at refs: HEAD, dev\)/m);
});
