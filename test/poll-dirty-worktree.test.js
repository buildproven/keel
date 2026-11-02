import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { poll } from '../src/poll.js';
import { fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-poll-dirty-');
});

const issue = {
  id: 'BUI-9',
  title: 't',
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
};

const WORK = 'export const add = (a, b) => a + b; // staged, never committed\n';

// A provider stop removes a clean worktree (REQ-LINEAR-19); a gate failure keeps every worktree: both name dirty ones.
for (const [stopped, file] of [
  ['quota', 'src/add.js'],
  ['review-unavailable', 'src/add.js'],
  ['max-attempts', 'src/add.js'],
  ['quota', 'src/new.js'], // an untracked file only
]) {
  test(`REQ-LINEAR-45 a run that leaves uncommitted changes keeps its worktree and the poll exits without a stack trace (${stopped}, ${file})`, async () => {
    const { dir } = fixtureRepo();
    const comments = [];
    const client = {
      listIssues: async () => [issue],
      comment: async (id, body) => comments.push({ id, body }),
      review: async (id) => comments.push({ id, action: 'review' }),
      stateType: async () => 'started',
    };
    const wt = join(tmp('keel-wt-'), 'wt');
    const runFn = () => {
      g(dir, 'worktree', 'add', '-q', '-b', 'keel/BUI-9', wt);
      // A hook rejected Keel's commit: the work is staged, not committed (REQ-RUN-65).
      writeFileSync(join(wt, file), WORK);
      if (file === 'src/add.js') g(wt, 'add', '-A');
      return { pass: false, stopped, branch: 'keel/BUI-9', worktree: wt, failure: 'commit failed (hooks?):\nUNSAFE_PARSING' };
    };
    const lines = [];
    const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn, log: (l) => lines.push(l) });
    assert.equal(results.length, 1);
    assert.ok(existsSync(wt), 'the worktree with uncommitted work is kept');
    assert.equal(readFileSync(join(wt, file), 'utf8'), WORK);
    assert.ok(g(wt, 'status', '--porcelain').includes(file));
    assert.equal(g(dir, 'branch', '--list', '--format=%(refname:short)', 'keel/BUI-9'), 'keel/BUI-9', 'its branch is kept');
    const body = comments.find((c) => c.body)?.body ?? '';
    assert.ok(body.includes(`worktree kept: uncommitted changes in ${wt}`), body);
    assert.ok(
      lines.some((l) => l.includes(`worktree kept: uncommitted changes in ${wt}`)),
      `the log names the kept worktree:\n${lines.join('\n')}`,
    );
  });
}
