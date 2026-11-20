import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { awakeNow, spawnAwake } from '../src/awake.js';
import { parseCard } from '../src/config.js';
import { gate, installProblem } from '../src/gate.js';
import { BUGGY, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const chore = () => parseCard('# T-1: deps\nkind: chore\nsize: S\n');
const problems = (r) => r.results.flatMap((x) => x.problems.map((p) => ({ stage: x.name, ...p })));

test('REQ-GATE-68 a timed-out install is install-timeout naming the limit; a failing one stays install-failed', () => {
  // What sh() returns when the watchdog stops an install at its limit: exit code null, no word of the timeout in its output.
  const timedOut = installProblem({ code: null, signal: 'SIGTERM', out: 'npm warn deprecated x\n', timedOut: true });
  assert.equal(timedOut.rule, 'install-timeout');
  assert.match(timedOut.detail, /900 s limit of awake time/);
  assert.deepEqual(installProblem({ code: 1, signal: null, out: 'npm error code E404\n', timedOut: false }), { rule: 'install-failed' });
  // A crash without a timeout (no exit code) is still a failed install, never a timeout.
  assert.deepEqual(installProblem({ code: null, signal: 'SIGKILL', out: '', timedOut: false }), { rule: 'install-failed' });
});

test('REQ-GATE-69 the awake clock leaves out the time a watchdog was suspended', () => {
  // The command stops its watchdog for 1.5 s, then a background job resumes it: to a 2 s limit (100 ms ticks) that gap
  // is suspended time, as a Mac's sleep is to the 900 s limit.
  const wall0 = performance.now();
  const awake0 = awakeNow();
  const r = spawnAwake('/bin/sh', ['-c', 'w=$PPID; (sleep 1.5; kill -CONT $w) & kill -STOP $w; wait'], { encoding: 'utf8' }, 2000);
  const wall = performance.now() - wall0;
  const awake = awakeNow() - awake0;
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.error, undefined);
  assert.ok(wall >= 1400, `wall ${wall}`);
  assert.ok(awake < wall - 1000, `awake ${awake} of wall ${wall}`);
  // With no suspension the awake clock runs with performance.now().
  const plain0 = awakeNow();
  const start = performance.now();
  spawnAwake('/bin/sh', ['-c', 'sleep 0.3'], {}, 2000);
  assert.ok(Math.abs(awakeNow() - plain0 - (performance.now() - start)) < 1, 'no gap, no correction');
});

test('REQ-GATE-69 the gate times install and checks on its awake clock, not on Date.now()', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  let t = 0;
  const clock = () => (t += 5000); // every read is 5 s on: each start/stop pair is exactly 5 s
  const config = fixtureConfig({ install: 'true', checks: { lint: 'true', test: 'true' }, testCommand: 'true' });
  const r = gate({ repo: dir, base, card: chore(), config, clock });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  const ms = Object.fromEntries(r.results.filter((x) => ['install', 'lint', 'test'].includes(x.name)).map((x) => [x.name, x.ms]));
  assert.deepEqual(ms, { install: 5000, lint: 5000, test: 5000 });
});

/** Lockfile content `v`: valid npm lockfile JSON for package-lock.json (REQ-GATE-54 checks it), plain text otherwise. */
const lockText = (lock, v) =>
  lock.endsWith('package-lock.json')
    ? `${JSON.stringify({ name: v, lockfileVersion: 3, packages: { '': { name: 'fixture' } } })}\n`
    : `${v}\n`;

/** A repo whose ignored dependency dir holds a package, as after an install, with a lockfile beside it. */
function repoWithDeps({ dep = 'node_modules', lock = 'package-lock.json', present = true } = {}) {
  const { dir, base } = fixtureRepo({ ...BUGGY, '.gitignore': `${dep}/\n`, [lock]: lockText(lock, 'v1') });
  if (present) {
    mkdirSync(join(dir, dep), { recursive: true });
    writeFileSync(join(dir, dep, 'pkg.txt'), 'old\n');
  }
  return { dir, base };
}

test('REQ-GATE-70 without install, a changed lockfile beside a linked dir fails at prepare before any check', () => {
  const { dir, base } = repoWithDeps();
  commit(dir, { 'package-lock.json': lockText('package-lock.json', 'v2') });
  const config = fixtureConfig({ checks: { touched: 'touch ran.marker' }, testCommand: 'true' });
  const r = gate({ repo: dir, base, card: chore(), config });
  assert.equal(r.pass, false);
  assert.deepEqual(problems(r), [
    {
      stage: 'prepare',
      rule: 'dependencies-changed',
      path: 'package-lock.json',
      detail: `package-lock.json changed, but keel.json sets no "install", so the checks would run on the node_modules installed in ${dir}: set "install" in keel.json`,
    },
  ]);
  assert.equal(
    r.results.some((x) => x.name === 'touched'),
    false,
  );
});

test('REQ-GATE-70 the lockfile of a nested or Python dependency dir counts; with install set, none fails', () => {
  const nested = repoWithDeps({ dep: 'web/node_modules', lock: 'web/pnpm-lock.yaml' });
  commit(nested.dir, { 'web/pnpm-lock.yaml': 'v2\n' });
  const nestedConfig = fixtureConfig({ shareDirs: ['web/node_modules'], checks: { ok: 'true' }, testCommand: 'true' });
  const r = gate({ repo: nested.dir, base: nested.base, card: chore(), config: nestedConfig });
  assert.deepEqual(
    problems(r).map((p) => [p.stage, p.rule, p.path]),
    [['prepare', 'dependencies-changed', 'web/pnpm-lock.yaml']],
  );

  const venv = repoWithDeps({ dep: '.venv', lock: 'uv.lock' });
  commit(venv.dir, { 'uv.lock': 'v2\n' });
  const v = gate({
    repo: venv.dir,
    base: venv.base,
    card: chore(),
    config: fixtureConfig({ checks: { ok: 'true' }, testCommand: 'true' }),
  });
  assert.deepEqual(
    problems(v).map((p) => [p.stage, p.rule, p.path]),
    [['prepare', 'dependencies-changed', 'uv.lock']],
  );

  const installed = repoWithDeps();
  commit(installed.dir, { 'package-lock.json': lockText('package-lock.json', 'v2') });
  const withInstall = fixtureConfig({ install: 'true', checks: { ok: 'true' }, testCommand: 'true' });
  const i = gate({ repo: installed.dir, base: installed.base, card: chore(), config: withInstall });
  assert.equal(i.pass, true, JSON.stringify(i.results));
});

test('REQ-GATE-70 a lockfile beside no linked dir, or a change to other files, does not fail', () => {
  const absent = repoWithDeps({ present: false });
  commit(absent.dir, { 'package-lock.json': lockText('package-lock.json', 'v2') });
  const config = fixtureConfig({ checks: { ok: 'true' }, testCommand: 'true' });
  const a = gate({ repo: absent.dir, base: absent.base, card: chore(), config });
  assert.equal(a.pass, true, JSON.stringify(a.results));

  // A root lockfile is not the lockfile of a nested dir (web/ is tracked, so the nested dir can be linked).
  const nested = repoWithDeps({ dep: 'web/node_modules', lock: 'web/notes.txt' });
  commit(nested.dir, { 'package-lock.json': lockText('package-lock.json', 'v2') });
  const n = gate({ repo: nested.dir, base: nested.base, card: chore(), config: { ...config, shareDirs: ['web/node_modules'] } });
  assert.equal(n.pass, true, JSON.stringify(n.results));

  const other = repoWithDeps();
  commit(other.dir, { 'notes.txt': 'x\n' });
  const o = gate({ repo: other.dir, base: other.base, card: chore(), config });
  assert.equal(o.pass, true, JSON.stringify(o.results));
});
