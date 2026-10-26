import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));
const temp = (p = 'keel-ho-prop-') => mkdtempSync(join(tmpdir(), p));

function keel(args, cwd) {
  const env = {
    ...process.env,
    KEEL_PROJECTS_FILE: join(temp('keel-ho-cfg-'), 'projects.json'),
    KEEL_STATE_DIR: temp('keel-ho-state-'),
  };
  delete env.LINEAR_API_KEY;
  const r = spawnSync(process.execPath, [KEEL, ...args], { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

/** A repo whose committed keel.json is the base config plus `extra`. */
function repo(extra) {
  const dir = temp('keel-ho-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'keel.json'), JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', ...extra }));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

// `keel test` loads keel.json at HEAD and runs testCommand, so it shows whether the config validates.
test('REQ-PROPOSE-8 keel.json accepts proposeMax, proposeApproval, proposeTier, and sourceGlobs', () => {
  const dir = repo({ proposeMax: 10, proposeApproval: true, proposeTier: 0, sourceGlobs: ['src/**/*.js', 'lib/**'] });
  const r = keel(['test'], dir);
  assert.equal(r.status, 0, r.out);
});

test('REQ-PROPOSE-8 the propose defaults validate: proposeMax 3, proposeApproval false, proposeTier null, empty sourceGlobs', () => {
  for (const extra of [{ proposeMax: 1 }, { proposeMax: 3, proposeApproval: false, proposeTier: null }, { sourceGlobs: [] }]) {
    const r = keel(['test'], repo(extra));
    assert.equal(r.status, 0, `${JSON.stringify(extra)}:\n${r.out}`);
  }
});

const INVALID = [
  ['proposeMax', 0],
  ['proposeMax', 11],
  ['proposeMax', 2.5],
  ['proposeMax', '3'],
  ['proposeApproval', 'yes'],
  ['proposeApproval', 1],
  ['proposeTier', -1],
  ['proposeTier', 99],
  ['proposeTier', 'last'],
  ['proposeTier', 0.5],
  ['sourceGlobs', 'src/**'],
  ['sourceGlobs', [1, 2]],
];
for (const [key, value] of INVALID) {
  test(`REQ-PROPOSE-8 keel.json rejects ${key}: ${JSON.stringify(value)}`, () => {
    const r = keel(['test'], repo({ [key]: value }));
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.stderr, new RegExp(key), r.out);
    assert.doesNotMatch(r.stderr, /unknown keys/, `${key} is a known key:\n${r.out}`);
  });
}
