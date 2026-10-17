import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fixtureRepo, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

test('REQ-LINEAR-8 keel poll --limit that is not a positive integer is a usage error, not a silent exit 0', () => {
  const { dir } = fixtureRepo();
  for (const limit of ['abc', '0', '-1', '1.5']) {
    const r = spawnSync(process.execPath, [BIN, 'poll', '--project', 'p', `--limit=${limit}`, '--repo', dir], {
      encoding: 'utf8',
      env: { ...process.env, KEEL_STATE_DIR: tmp('keel-state-'), LINEAR_API_KEY: '' },
    });
    assert.equal(r.status, 2, `--limit ${limit}: ${r.stderr}`);
    assert.match(r.stderr, /--limit must be a positive integer/);
  }
});
