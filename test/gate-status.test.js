import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { keelGateRequired } from '../src/doctor.js';
import { gateDescription } from '../src/status.js';
import { run } from '../src/run.js';
import { FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp, write } from './helpers.js';

// A hung helper fails the test in two minutes instead of stalling the suite (BUI-1213).
const test = (name, fn) => nodeTest(name, { timeout: 120000 }, fn);

const BIN = resolve('bin/keel.js');
const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const reviewer = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0); console.log('VERDICT: pass')"],
};
const card = () => parseCard('# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

/**
 * A fake `gh` on PATH. `api …/statuses/<sha>` exits FAKE_STATUS_EXIT; a `keel/gate` lookup prints FAKE_GATE_REQUIRED;
 * any other `api` call prints 1 (required checks, allow_auto_merge); `pr create` prints a URL. Every call is logged.
 */
function fakeGh({ statusExit = 0, gateRequired = 'true' } = {}) {
  const bin = tmp('keel-bin-');
  const log = join(bin, 'calls.jsonl');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === 'api' && a.some((x) => /\\/statuses\\//.test(x))) { if (${statusExit}) console.error('No commit found for SHA'); process.exit(${statusExit}); }
if (a[0] === 'api' && a.join(' ').includes('keel/gate')) { console.log(${JSON.stringify(gateRequired)}); process.exit(0); }
if (a[0] === 'api') { console.log('1'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'create') { console.log('https://example.test/pr/1'); process.exit(0); }
process.exit(0);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return { bin, calls };
}

function withPath(bin, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    return fn();
  } finally {
    process.env.PATH = old;
  }
}

const field = (args, name) => args.find((x) => x.startsWith(`${name}=`))?.slice(name.length + 1);
const statusCalls = (calls) => calls.filter((a) => a[0] === 'api' && a.some((x) => /\/statuses\//.test(x)));

function repoWithRemote() {
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

test('REQ-RUN-23 with --pr, keel run posts a keel/gate success status on the certified SHA before it enables auto-merge', () => {
  const gh = fakeGh();
  const r = withPath(gh.bin, () =>
    run({
      repo: repoWithRemote(),
      card: card(),
      config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
      pr: true,
      merge: true,
    }),
  );
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.merge.state, 'auto', r.merge.reason);
  const calls = gh.calls();
  const posts = statusCalls(calls);
  assert.equal(posts.length, 1);
  const [post] = posts;
  assert.ok(post.includes(`repos/{owner}/{repo}/statuses/${r.receipt.head}`));
  assert.equal(field(post, 'state'), 'success');
  assert.equal(field(post, 'context'), 'keel/gate');
  assert.match(field(post, 'description'), /^passed; review by exec\/exec-review\/high$/);
  const merge = calls.findIndex((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.ok(calls.indexOf(post) < merge, 'status before auto-merge');
});

test('REQ-RUN-23 when the keel/gate status cannot be posted, auto-merge is not enabled and the run reports why', () => {
  const gh = fakeGh({ statusExit: 1 });
  const r = withPath(gh.bin, () =>
    run({
      repo: repoWithRemote(),
      card: card(),
      config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
      pr: true,
      merge: true,
    }),
  );
  assert.equal(r.merge.state, 'failed');
  assert.match(r.merge.reason, /keel\/gate status not posted: No commit found for SHA/);
  assert.equal(
    gh.calls().find((a) => a[0] === 'pr' && a[1] === 'merge'),
    undefined,
  );
});

test('REQ-RUN-23 with --pr and review off, the status says review is off', () => {
  const gh = fakeGh();
  const r = withPath(gh.bin, () => run({ repo: repoWithRemote(), card: card(), config: fixtureConfig({ tiers: [builder] }), pr: true }));
  assert.equal(r.pass, true, r.failure);
  assert.equal(field(statusCalls(gh.calls())[0], 'description'), 'passed; review off in keel.json');
});

const CONFIG = JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: false });

/** A clone whose origin main holds keel.json, on a new branch. */
function clone() {
  const { dir: origin } = fixtureRepo();
  commit(origin, { 'keel.json': CONFIG }, 'chore: keel config');
  const dir = realpathSync(tmp('keel-clone-'));
  g(dir, 'clone', '-q', origin, '.');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'commit.gpgsign', 'false');
  g(dir, 'checkout', '-q', '-b', 'fix/add');
  return dir;
}

const keel = (cwd, args, bin) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEL_STATE_DIR: tmp('keel-state-'), KEEL_AUTHOR: '' },
  });

test('REQ-CLI-10 keel gate --status posts keel/gate success on the gated HEAD after a pass', () => {
  const dir = clone();
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add numbers');
  const gh = fakeGh();
  const r = keel(dir, ['gate', '--status'], gh.bin);
  assert.equal(r.status, 0, r.stderr);
  const [post] = statusCalls(gh.calls());
  assert.ok(post.includes(`repos/{owner}/{repo}/statuses/${head}`));
  assert.equal(field(post, 'state'), 'success');
  assert.equal(field(post, 'context'), 'keel/gate');
  assert.match(r.stderr, /^keel: status keel\/gate success on [0-9a-f]{40}$/m);
});

test('REQ-CLI-10 keel gate --status posts failure naming the first failing stage, and exits 1', () => {
  const dir = clone();
  write(dir, { 'src/add.js': 'export const add = (a, b) => a + b;\n' });
  commit(dir, {}, 'fix: no test');
  const gh = fakeGh();
  const r = keel(dir, ['gate', '--status'], gh.bin);
  assert.equal(r.status, 1);
  const [post] = statusCalls(gh.calls());
  assert.equal(field(post, 'state'), 'failure');
  assert.match(field(post, 'description'), /^failed at red-proof/);
});

test('REQ-CLI-10 keel gate --status exits 1 when the status cannot be posted, even after a pass', () => {
  const dir = clone();
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add numbers');
  const gh = fakeGh({ statusExit: 1 });
  const r = keel(dir, ['gate', '--status'], gh.bin);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^keel: status keel\/gate not posted: No commit found for SHA/m);
});

test('REQ-CLI-10 keel gate without --status posts nothing; --status on another command is a usage error', () => {
  const dir = clone();
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add numbers');
  const gh = fakeGh();
  assert.equal(keel(dir, ['gate'], gh.bin).status, 0);
  assert.equal(statusCalls(gh.calls()).length, 0);
  const u = keel(dir, ['doctor', '--status'], gh.bin);
  assert.equal(u.status, 2);
  assert.match(u.stderr, /--status is an option of gate only/);
});

test('REQ-CLI-4 keelGateRequired reads whether the base branch requires the keel/gate status', () => {
  const { dir } = fixtureRepo();
  assert.equal(
    withPath(fakeGh({ gateRequired: 'true' }).bin, () => keelGateRequired(dir, 'main')),
    true,
  );
  assert.equal(
    withPath(fakeGh({ gateRequired: 'false' }).bin, () => keelGateRequired(dir, 'main')),
    false,
  );
});

/** A fake `gh` that answers `api <path> --jq <expr>` by running the real jq over the payload for that path. */
function jqGh(payloads) {
  const bin = tmp('keel-bin-');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
const payloads = ${JSON.stringify(payloads)};
const key = Object.keys(payloads).find((k) => a.some((x) => x.includes(k)));
if (!key) process.exit(1);
const r = spawnSync('jq', ['-n', '--argjson', 'p', JSON.stringify(payloads[key]), '$p | ' + a[a.indexOf('--jq') + 1]], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, encoding: 'utf8' });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.status);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

test('REQ-CLI-4 keelGateRequired reads classic protection that has contexts but no checks field, and rulesets', () => {
  const { dir } = fixtureRepo();
  const classic = { required_status_checks: { strict: true, contexts: ['ci', 'keel/gate'] }, 'rules/branches': [] };
  assert.equal(
    withPath(jqGh(classic), () => keelGateRequired(dir, 'main')),
    true,
  );
  const checksOnly = { required_status_checks: { strict: true, checks: [{ context: 'keel/gate', app_id: null }] }, 'rules/branches': [] };
  assert.equal(
    withPath(jqGh(checksOnly), () => keelGateRequired(dir, 'main')),
    true,
  );
  const ruleset = {
    'rules/branches': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'keel/gate' }] } }],
  };
  assert.equal(
    withPath(jqGh(ruleset), () => keelGateRequired(dir, 'main')),
    true,
  );
  assert.equal(
    withPath(jqGh({ required_status_checks: { contexts: ['ci'] }, 'rules/branches': [] }), () => keelGateRequired(dir, 'main')),
    false,
  );
});

test('REQ-CLI-4 keelGateRequired URL-encodes a branch name that has a slash', () => {
  const { dir } = fixtureRepo();
  const gh = fakeGh();
  withPath(gh.bin, () => keelGateRequired(dir, 'release/1'));
  const paths = gh.calls().map((a) => a.find((x) => x.startsWith('repos/')));
  assert.ok(paths.length > 0);
  assert.ok(
    paths.every((p) => p.includes('/branches/release%2F1')),
    paths.join(' '),
  );
});

test('REQ-CLI-10 a failed configured check has no rule, so the description names only the stage', () => {
  const receipt = {
    pass: false,
    results: [
      { name: 'lint', pass: true, problems: [] },
      { name: 'test', pass: false, problems: [] },
    ],
  };
  assert.equal(gateDescription(receipt, { review: true }), 'failed at test');
});

test('REQ-RUN-23 with --merge and a merge policy that is off, a failed status post still makes the merge state failed', () => {
  const gh = fakeGh({ statusExit: 1 });
  const r = withPath(gh.bin, () =>
    run({ repo: repoWithRemote(), card: card(), config: fixtureConfig({ tiers: [builder] }), pr: true, merge: true }),
  );
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.merge.state, 'failed');
  assert.match(r.merge.reason, /keel\/gate status not posted: No commit found for SHA/);
});

test('REQ-RUN-23 the status is posted before the PR opens, so a failed post shows in the PR body as auto-merge off', () => {
  const gh = fakeGh({ statusExit: 1 });
  withPath(gh.bin, () =>
    run({
      repo: repoWithRemote(),
      card: card(),
      config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
      pr: true,
      merge: true,
    }),
  );
  const calls = gh.calls();
  const create = calls.find((a) => a[0] === 'pr' && a[1] === 'create');
  assert.ok(calls.indexOf(statusCalls(calls)[0]) < calls.indexOf(create), 'status before PR');
  assert.match(create[create.indexOf('--body') + 1], /Auto-merge: off — keel\/gate status not posted: No commit found for SHA/);
});
