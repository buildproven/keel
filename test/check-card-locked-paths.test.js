import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { commit, fixtureRepo, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/** Run `keel check-card` on a card file outside the repo, as the cards skill drafts one. */
function check(dir, header, requirements = '- REQ-1: When add runs, it shall add.') {
  const file = join(tmp('keel-card-'), 'BUI-9.md');
  writeFileSync(file, `# BUI-9: add numbers\nkind: bug\nsize: S\n${header}\n\n## Requirements\n\n${requirements}\n`);
  return spawnSync(process.execPath, [BIN, 'check-card', file, '--repo', dir, '--base', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

const LOCKED = 'keel.json is locked (verification file); add it to allowEdits if the card must change it';

test('REQ-CARD-13 check-card fails a card that names a locked path without allowEdits', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': '{}\n', 'src/a.js': 'export const a = 1;\n' }, 'policy');
  const r = check(dir, 'paths: keel.json, src/a.js');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`check-card BUI-9: ${LOCKED}`), r.stderr);
  assert.doesNotMatch(r.stderr, /src\/a\.js is locked/, 'an unlocked path is not reported');
  assert.doesNotMatch(r.stderr, /pass/, r.stderr);
});

test('REQ-CARD-13 check-card does not treat prose that says new as a paths (new) mark', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': '{}\n' }, 'policy');
  const r = check(dir, 'paths: keel.json', '- REQ-1: Add a new key named install to keel.json.');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`check-card BUI-9: ${LOCKED}`), r.stderr);
});

test('REQ-CARD-13 check-card does not exempt a locked file on base that paths incorrectly marks new', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': '{}\n' }, 'policy');
  const r = check(dir, 'paths: keel.json (new)');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`check-card BUI-9: ${LOCKED}`), r.stderr);
});

test('REQ-CARD-13 check-card treats a differently cased base path as existing despite a paths (new) mark', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': '{}\n' }, 'policy');
  const r = check(dir, 'paths: KEEL.JSON (new)');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('KEEL.JSON is locked (verification file)'), r.stderr);
});

test('REQ-CARD-13 check-card folds letter case and drops ./ as the gate does when it matches a locked path', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'sub/Makefile': 'all:\n', 'py/CONFTEST.PY': '\n', '.github/workflows/ci.yml': 'on: push\n' }, 'runners');
  const r = check(dir, 'paths: ./sub/Makefile, py/CONFTEST.PY, .github/workflows/ci.yml');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(': sub/Makefile is locked (verification file)'), r.stderr);
  assert.ok(r.stderr.includes('py/CONFTEST.PY is locked (verification file)'), r.stderr);
  assert.ok(r.stderr.includes('.github/workflows/ci.yml is locked (verification file)'), r.stderr);
});

test('REQ-CARD-13 check-card reads verificationPaths from keel.json at the base', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ verificationPaths: ['ci/**'] }), 'ci/run.sh': 'true\n', Makefile: 'all:\n' }, 'policy');
  const r = check(dir, 'paths: ci/run.sh, Makefile');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('ci/run.sh is locked (verification file)'), r.stderr);
  assert.doesNotMatch(r.stderr, /Makefile is locked/, 'the repo replaced the default list');
});

test('REQ-CARD-13 check-card passes a locked path listed in allowEdits or marked new', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': '{}\n', 'src/a.js': 'export const a = 1;\n' }, 'policy');
  const allowed = check(dir, 'paths: keel.json, src/a.js\nallowEdits: keel.json');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /pass/);
  const globbed = check(dir, 'paths: keel.json, src/a.js\nallowEdits: *.json');
  assert.equal(globbed.status, 0, globbed.stderr);
  const marked = check(dir, 'paths: .github/workflows/new.yml (new), src/a.js');
  assert.equal(marked.status, 0, marked.stderr);
});

test('REQ-CARD-13 check-card does not report a glob or a directory in paths that covers locked files', () => {
  const { dir } = fixtureRepo();
  commit(dir, { '.github/workflows/ci.yml': 'on: push\n' }, 'ci');
  const r = check(dir, 'paths: .github/**, src/add.js');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /locked/);
  const folder = check(dir, 'paths: .github/workflows/, src/add.js');
  assert.equal(folder.status, 0, `a directory is a scope like a glob: ${folder.stderr}`);
});

test('REQ-CARD-14 check-card does not report a path listed in allowEdits as missing on base', () => {
  const { dir } = fixtureRepo();
  const r = check(dir, 'paths: .github/workflows/new.yml, src/add.js\nallowEdits: .github/workflows/new.yml');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /not on base|locked/, r.stderr);
  const still = check(dir, 'paths: .github/workflows/new.yml, lib/gone.js\nallowEdits: .github/workflows/new.yml');
  assert.equal(still.status, 1, still.stderr);
  assert.ok(still.stderr.includes('mark it `lib/gone.js (new)`'), 'a missing path outside allowEdits is still reported');
  assert.doesNotMatch(still.stderr, /new\.yml/, still.stderr);
});
