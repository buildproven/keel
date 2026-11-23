import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { judgeCard } from '../src/check-card.js';
import { readCard } from '../src/config.js';
import { commit, fixtureRepo, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

function cardFile(header, kind = 'feature') {
  const file = join(tmp('keel-card-'), 'BUI-9.md');
  writeFileSync(
    file,
    `# BUI-9: add numbers\nkind: ${kind}\nsize: S\n${header}\n\n## Requirements\n\n- REQ-1: When add runs, it shall add.\n`,
  );
  return file;
}

/** Run `keel check-card` on a card file outside the repo, as the cards skill drafts one. */
function check(dir, header, kind) {
  return spawnSync(process.execPath, [BIN, 'check-card', cardFile(header, kind), '--repo', dir, '--base', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

const POLICY = JSON.stringify({ checks: { lint: 'npm run lint' }, testCommand: 'npm test' });
const PKG = JSON.stringify({ type: 'module', scripts: { test: 'node scripts/test-all.mjs', lint: 'sh ./scripts/lint.sh' } });

function repo() {
  const { dir } = fixtureRepo();
  commit(
    dir,
    {
      'keel.json': `${POLICY}\n`,
      'package.json': `${PKG}\n`,
      'scripts/test-all.mjs': '\n',
      'scripts/lint.sh': '\n',
      'packages/x/package.json': '{"scripts":{"test":"node t.js"}}\n',
      'src/a.js': 'export const a = 1;\n',
    },
    'policy',
  );
  return dir;
}

const message = (p) => `${p} is locked (scripts or runner); add it to allowEdits if the card must change it`;

test('REQ-CARD-16 check-card fails a card that names the root package.json without allowEdits', () => {
  const dir = repo();
  const r = check(dir, 'paths: package.json, src/a.js');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`check-card BUI-9: ${message('package.json')}`), r.stderr);
  assert.doesNotMatch(r.stderr, /src\/a\.js is locked/, 'an unlocked path is not reported');
  assert.doesNotMatch(r.stderr, /pass/, r.stderr);
  const bug = check(dir, 'paths: ./package.json', 'bug');
  assert.equal(bug.status, 1, bug.stderr);
  assert.ok(bug.stderr.includes(message('package.json')), 'a bug card and a leading ./ are judged alike');
});

test('REQ-CARD-16 check-card fails a card that names a runner script the gate locks without allowEdits', () => {
  const dir = repo();
  const direct = check(dir, 'paths: scripts/test-all.mjs');
  assert.equal(direct.status, 1, direct.stderr);
  assert.ok(direct.stderr.includes(`check-card BUI-9: ${message('scripts/test-all.mjs')}`), direct.stderr);
  // A check's script is followed through `npm run` as the gate follows it (REQ-GATE-4), letter case folded.
  const viaCheck = check(dir, 'paths: Scripts/Lint.sh');
  assert.equal(viaCheck.status, 1, viaCheck.stderr);
  assert.ok(viaCheck.stderr.includes(message('Scripts/Lint.sh')), viaCheck.stderr);
});

test('REQ-CARD-16 check-card passes a scripts or runner path listed in allowEdits', () => {
  const dir = repo();
  const r = check(dir, 'paths: package.json, scripts/test-all.mjs, src/a.js\nallowEdits: package.json, scripts/*.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /is locked/, r.stderr);
});

test('REQ-CARD-16 check-card does not flag a nested package.json or a script no command runs', () => {
  const dir = repo();
  commit(dir, { 'scripts/other.mjs': '\n' }, 'other');
  const r = check(dir, 'paths: packages/x/package.json, scripts/other.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /is locked/, r.stderr);
});

test('REQ-CARD-16 judgeCard lists a scripts lock in lockedWithoutAllow, once when verificationPaths also locks it', () => {
  const dir = repo();
  commit(dir, { 'keel.json': `${JSON.stringify({ ...JSON.parse(POLICY), verificationPaths: ['package.json'] })}\n` }, 'lock');
  const card = readCard(cardFile('paths: package.json, scripts/lint.sh'));
  const { lockedWithoutAllow, messages } = judgeCard(dir, 'HEAD', card);
  assert.deepEqual(lockedWithoutAllow, ['package.json', 'scripts/lint.sh']);
  assert.equal(messages.filter((m) => m.startsWith('package.json is locked')).length, 1, messages.join('\n'));
  assert.ok(messages.includes(message('scripts/lint.sh')), messages.join('\n'));
});

test('REQ-CARD-16 check-card flags the root package.json on a base without keel.json, and not on a chore card', () => {
  const { dir } = fixtureRepo();
  const r = check(dir, 'paths: package.json');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(message('package.json')), r.stderr);
  const chore = check(dir, 'paths: package.json', 'chore');
  assert.doesNotMatch(chore.stderr, /scripts or runner/, 'only a bug or feature card is judged');
});
