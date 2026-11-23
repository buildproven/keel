import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { commit, fixtureRepo, g, tmp, write } from './helpers.js';

const BIN = resolve('bin/keel.js');
const FAKE = resolve('test/fake-worker.js');
const keel = (cwd, args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      KEEL_STATE_DIR: tmp('keel-state-'),
      TMPDIR: tmp('keel-tmpdir-'),
      LINEAR_API_KEY: '',
      LINEAR_BUILDPROVEN_KEY: '',
    },
  });

const config = (project) =>
  JSON.stringify({
    checks: { test: 'true' },
    testCommand: 'true',
    linearProject: project,
    review: false,
    learnStart: false,
    maxAttempts: 1,
    tiers: [{ provider: 'exec', model: 'exec-auth', effort: 'low', command: ['node', FAKE, 'auth'], family: 'exec' }],
  });

const CARD = '# T-9: fix add\n\nkind: bug\nsize: S\npaths: src/fresh.js\n\n## Requirements\n\n- REQ-ADD-1: add shall sum.\n';

/**
 * A clone whose local main (and its origin/main ref) is one commit behind origin, as a primary checkout that has not
 * pulled: only origin has `linearProject: "fresh"`, `cards/T-9.md` and `src/fresh.js`.
 */
function behindOrigin() {
  const { dir: origin } = fixtureRepo();
  commit(origin, { 'keel.json': config('stale') }, 'chore: keel config');
  const dir = realpathSync(tmp('keel-clone-'));
  g(dir, 'clone', '-q', origin, '.');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'commit.gpgsign', 'false');
  const fresh = commit(origin, { 'keel.json': config('fresh'), 'cards/T-9.md': CARD, 'src/fresh.js': 'export {};\n' }, 'feat: fresh');
  return { dir, fresh };
}

const cardOutside = () => {
  const file = join(tmp('keel-card-'), 'T-9.md');
  write('/', { [file]: CARD });
  return file;
};

test("REQ-BASE-1 run and poll without --base fetch origin's default branch and build on it, not on a stale local main", () => {
  const { dir, fresh } = behindOrigin();
  // A stale base reads linearProject "stale" and refuses --project fresh; origin's base reads "fresh".
  for (const args of [
    ['run', 'DEMO-7', '--project', 'fresh'],
    ['poll', '--issue', 'DEMO-7', '--project', 'fresh'],
  ]) {
    const r = keel(dir, args);
    assert.doesNotMatch(r.stderr, /differs from "linearProject" "stale"/, `${args[0]}: ${r.stderr}`);
    assert.match(r.stderr, /LINEAR_API_KEY/, `${args[0]}: ${r.stderr}`);
  }
  assert.equal(g(dir, 'rev-parse', 'origin/main'), fresh, 'origin/main was fetched');
  assert.notEqual(g(dir, 'rev-parse', 'main'), fresh, 'the local main is left as it was');
  // A card committed only on origin is on the base of `keel run <card.md>`.
  const r = keel(dir, ['run', 'cards/T-9.md']);
  assert.doesNotMatch(r.stderr, /not in the base commit/, r.stderr);
  assert.match(r.stderr, /STOPPED \(auth\)/, r.stderr);
});

test('REQ-BASE-2 run, poll and check-card without --base resolve the same base commit on a checkout behind origin', () => {
  const { dir } = behindOrigin();
  // check-card: src/fresh.js is only on origin, so the card passes only on origin's base.
  const file = keel(dir, ['check-card', cardOutside()]);
  assert.equal(file.status, 0, file.stderr);
  // check-card of an issue reads linearProject at its base, as run and poll do.
  const issue = keel(dir, ['check-card', 'DEMO-7', '--project', 'fresh']);
  assert.doesNotMatch(issue.stderr, /differs from "linearProject" "stale"/, issue.stderr);
  assert.match(issue.stderr, /LINEAR_API_KEY/, issue.stderr);
  const viaRun = keel(dir, ['run', 'DEMO-7', '--project', 'fresh']);
  const viaPoll = keel(dir, ['poll', '--issue', 'DEMO-7', '--project', 'fresh']);
  assert.equal(viaRun.stderr.split('\n')[0], viaPoll.stderr.split('\n')[0]);
  assert.equal(viaRun.status, viaPoll.status);
});

test('REQ-BASE-2 without an origin remote, run, poll and check-card all use HEAD', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': config('fresh'), 'src/fresh.js': 'export {};\n' }, 'feat: fresh');
  assert.equal(keel(dir, ['check-card', cardOutside()]).status, 0);
  for (const args of [
    ['run', 'DEMO-7', '--project', 'fresh'],
    ['poll', '--issue', 'DEMO-7', '--project', 'fresh'],
  ]) {
    const r = keel(dir, args);
    assert.doesNotMatch(r.stderr, /cannot fetch/, r.stderr);
    assert.match(r.stderr, /LINEAR_API_KEY/, r.stderr);
  }
});

test('REQ-BASE-3 an unreachable origin stops run, poll and check-card with an error naming the remote, no stale fallback', () => {
  const { dir } = behindOrigin();
  g(dir, 'remote', 'set-url', 'origin', join(tmp('keel-gone-'), 'no-such-repo'));
  for (const args of [
    ['run', 'DEMO-7', '--project', 'fresh'],
    ['poll', '--issue', 'DEMO-7', '--project', 'fresh'],
    ['check-card', cardOutside()],
    ['run', cardOutside()],
  ]) {
    const r = keel(dir, args);
    assert.equal(r.status, 4, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^keel: \S+ stopped: cannot fetch remote origin \(.*no-such-repo\)/m, r.stderr);
    assert.match(r.stderr, /pass --base <ref>/);
    assert.doesNotMatch(r.stderr, /LINEAR_API_KEY|stale|STOPPED|\n\s+at /, r.stderr);
  }
});

test('REQ-BASE-3 the fetch error leaves out the credentials of the remote URL', () => {
  const { dir } = behindOrigin();
  const userinfo = ['keel', 'user:', 'hunter', '42'].join('');
  g(dir, 'remote', 'set-url', 'origin', `http://${userinfo}@127.0.0.1:9/repo.git`);
  const r = keel(dir, ['check-card', cardOutside()]);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /cannot fetch remote origin \(http:\/\/127\.0\.0\.1:9\/repo\.git\)/, r.stderr);
  assert.ok(!r.stderr.includes('hunter42'), r.stderr);
});
