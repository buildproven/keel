import assert from 'node:assert/strict';
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { FIXTURE_TEST, commit, fixtureRepo, g, tmp } from './helpers.js';

const BIN = resolve('bin/keel.js');

test('REQ-CLI-4 on a feature branch, keel doctor reads merge readiness and keel/gate of the default branch', () => {
  const { dir: origin } = fixtureRepo();
  commit(origin, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST }) }, 'chore: keel');
  const dir = realpathSync(tmp('keel-clone-'));
  g(dir, 'clone', '-q', origin, '.');
  g(dir, 'checkout', '-q', '-b', 'feat/x');
  const bin = tmp('keel-bin-');
  const log = join(bin, 'calls');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
console.log(process.argv.join(' ').includes('keel/gate') ? 'true' : '1');
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEL_STATE_DIR: tmp('keel-state-') },
  });
  assert.match(r.stderr, /INFO keel\/gate required yes/);
  const paths = readFileSync(log, 'utf8').match(/branches\/[^/\s]+/g);
  assert.ok(paths.length > 0);
  assert.ok(
    paths.every((p) => p === 'branches/main'),
    paths.join(' '),
  );
});
