import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeReadiness } from '../src/doctor.js';
import { pollExitCode } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

function withGh(allow, fn) {
  const bin = tmp('keel-bin-');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
console.log(a.includes('allow_auto_merge') ? '${allow}' : '1');
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    return fn();
  } finally {
    process.env.PATH = old;
  }
}

test('REQ-CLI-4 merge readiness requires allow_auto_merge on the repository', () => {
  const { dir } = fixtureRepo();
  const off = withGh('false', () => mergeReadiness({ repo: dir, branch: 'main', config: { review: true } }));
  assert.equal(off.ready, false);
  assert.equal(off.reason, 'auto-merge is off in the repository settings');
  const on = withGh('true', () => mergeReadiness({ repo: dir, branch: 'main', config: { review: true } }));
  assert.equal(on.ready, true);
});

test('REQ-CLI-4 an empty, null, or false allow_auto_merge answer is not merge-ready', () => {
  const { dir } = fixtureRepo();
  for (const answer of ['', 'null', 'false']) {
    const r = withGh(answer, () => mergeReadiness({ repo: dir, branch: 'main', config: { review: true } }));
    assert.equal(r.ready, false, `answer ${JSON.stringify(answer)}`);
    assert.equal(r.reason, 'auto-merge is off in the repository settings');
  }
});

test('REQ-RUN-20 keel poll exits 1 when any run auto-merge call failed', () => {
  const merged = (state) => ({ outcome: 'inReview', issue: 'BUI-1', result: { pass: true, merge: { state } } });
  assert.equal(pollExitCode([merged('failed')]), 1);
  assert.equal(pollExitCode([merged('auto'), merged('failed')]), 1);
  assert.equal(pollExitCode([merged('auto'), merged('off')]), 0);
  assert.equal(pollExitCode([{ outcome: 'failed', issue: 'BUI-1' }]), 1);
  assert.equal(pollExitCode([{ outcome: 'deferred', issue: 'BUI-1' }]), 3);
});
