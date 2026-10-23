import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readCard } from '../src/config.js';
import { commit, FIXTURE_TEST, fixtureRepo, tmp } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/keel.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));

/** keel with its own projects file and state dir; no LINEAR_API_KEY, so nothing can reach Linear. */
function keelWith(file, state = tmp('keel-cli-projects-state-')) {
  const env = { ...process.env, KEEL_PROJECTS_FILE: file, KEEL_STATE_DIR: state };
  delete env.LINEAR_API_KEY;
  return (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
}

test('REQ-MULTI-3 keel projects lists the ranked repos; an empty list says how to add one', () => {
  const file = join(tmp('keel-cli-projects-'), 'projects.json');
  const r = keelWith(file)('projects');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /none yet: keel projects add <dir>/);
  assert.ok(!existsSync(file), 'listing writes nothing');
});

test('REQ-MULTI-4 keel projects add, active, pause, and remove edit the file and print the list', () => {
  const file = join(tmp('keel-cli-projects-'), 'projects.json');
  const keel = keelWith(file);
  const a = fixtureRepo().dir;
  const b = fixtureRepo().dir;
  assert.equal(keel('projects', 'add', a).status, 0);
  const added = keel('projects', 'add', b, '--rank', '1');
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, new RegExp(` 1\\. active {2}${b}[\\s\\S]* 2\\. active {2}${a}`));
  const active = keel('projects', 'active', '1');
  assert.match(active.stdout, /top 1 unpaused are active/);
  assert.match(active.stdout, new RegExp(` 2\\. waiting ${a}`));
  assert.match(keel('projects', 'pause', b).stdout, new RegExp(` 1\\. paused {2}${b}[\\s\\S]* 2\\. active {2}${a}`));
  keel('projects', 'remove', b);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { active: 1, projects: [{ repo: a }] });
  for (const args of [
    ['projects', 'add'],
    ['projects', 'frob'],
    ['projects', 'remove', '/nowhere'],
    ['projects', 'list', '--rank', '2'],
  ]) {
    const r = keel(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
});

test('REQ-MULTI-5 poll --projects rejects per-repo flags and an empty list as usage errors', () => {
  const file = join(tmp('keel-cli-projects-'), 'projects.json');
  const keel = keelWith(file);
  const empty = keel('poll', '--projects');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /no active projects in .*projects\.json/);
  writeFileSync(file, JSON.stringify({ projects: [fixtureRepo().dir] }));
  for (const flag of [['--repo', '.'], ['--issue', 'BUI-1'], ['--base', 'HEAD'], ['--file-only']]) {
    const r = keel('poll', '--projects', ...flag);
    assert.equal(r.status, 2, flag.join(' '));
    assert.match(r.stderr, new RegExp(`${flag[0]} cannot be combined with --projects`));
  }
  assert.equal(keel('gate', '--projects').status, 2, '--projects is an option of poll only');
});

test('REQ-MULTI-5 poll --projects runs the active projects in rank order; one project failing does not stop the next', () => {
  const file = join(tmp('keel-cli-projects-'), 'projects.json');
  const missing = join(tmp('keel-cli-projects-'), 'gone');
  const noPolicy = fixtureRepo().dir; // no keel.json: its pass fails before Linear is read
  const paused = fixtureRepo().dir;
  writeFileSync(file, JSON.stringify({ active: 2, projects: [missing, { repo: paused, paused: true }, noPolicy] }));
  const r = keelWith(file)('poll', '--projects');
  assert.equal(r.status, 1, r.stderr);
  const order = [r.stderr.indexOf(`project 1/2: ${missing}`), r.stderr.indexOf(`project 2/2: ${noPolicy}`)];
  assert.ok(order[0] >= 0 && order[1] > order[0], r.stderr);
  assert.match(r.stderr, new RegExp(`${missing}: .*is not a directory`));
  assert.match(r.stderr, new RegExp(`${noPolicy}: keel\\.json: "checks" and "testCommand" are not set`));
  assert.ok(!r.stderr.includes(paused), 'a paused project is not polled');
});

test('REQ-PROPOSE-5 keel propose writes the cards as files outside the repo and prints how to run each', () => {
  const answer = [
    'PROPOSALS',
    'TITLE: Fix add to sum',
    'The add helper subtracts.',
    '',
    '## Requirements',
    '',
    '- REQ-ADD-1: When add is called with 2 and 3, the add helper shall return 5.',
    '',
    '## Acceptance',
    '',
    '- [ ] a test calls add(2, 3) and gets 5',
    '',
    '```keel',
    'kind: bug',
    'size: S',
    'paths: src/add.js, test/add-sum.test.js',
    '```',
  ].join('\n');
  const script = join(tmp('keel-cli-propose-'), 'script.json');
  writeFileSync(script, JSON.stringify([`say:${answer}`]));
  const { dir } = fixtureRepo();
  const tier = { provider: 'exec', model: 'fake', effort: 'high', command: [process.execPath, FAKE, 'script', script] };
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: false, tiers: [tier] }) });
  const state = tmp('keel-cli-propose-state-');
  const r = keelWith(join(state, 'projects.json'), state)('propose', '--repo', dir, '--focus', 'correctness');
  assert.equal(r.status, 0, r.stderr);
  const path = join(state, 'proposed', dir.split('/').at(-1), 'PROP-1.md');
  assert.match(r.stdout, new RegExp(`${path} {2}Fix add to sum\\n {2}keel run ${path} --repo ${dir} --pr`));
  assert.equal(readCard(path).kind, 'bug');
  assert.equal(keelWith(join(state, 'p.json'), state)('propose', '--repo', dir, 'extra').status, 2, 'propose takes no argument');
  assert.equal(keelWith(join(state, 'p.json'), state)('gate', '--focus', 'x').status, 2, '--focus is an option of propose only');
});
