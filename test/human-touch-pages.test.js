import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubPrs } from '../src/autonomy.js';
import { tmp } from './helpers.js';

const BOT = { __typename: 'Bot', login: 'linear' };
const USER = { __typename: 'User', login: 'brett' };
const conn = (authors, endCursor = null) => ({
  pageInfo: { hasNextPage: Boolean(endCursor), endCursor },
  nodes: authors.map((author) => ({ author })),
});

/**
 * A fake `gh` (Node) that answers `repo view`, the PR list query, and the per-PR comments and reviews queries from
 * `replies` (keyed `prs`, `comments`, `reviews`), and logs each graphql call's variables to `calls.jsonl`.
 */
function fakeGh(replies, { fail = null } = {}) {
  const bin = tmp('keel-gh-pages-');
  writeFileSync(join(bin, 'replies.json'), JSON.stringify(replies));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'repo') { console.log('o/r'); process.exit(0); }
const vars = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-f' || args[i] === '-F') { const [k, ...v] = args[i + 1].split('='); vars[k] = v.join('='); }
const kind = /pullRequest\\(number/.test(vars.query) ? (/comments\\(first/.test(vars.query) ? 'comments' : 'reviews') : 'prs';
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ kind, args, vars }) + '\\n');
if (${JSON.stringify(fail)} === kind) { console.error('gh: rate limited'); process.exit(1); }
console.log(JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, 'replies.json'), 'utf8'))[kind]));
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

function withGh(bin, fn) {
  const dir = tmp('keel-repo-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    return fn(dir);
  } finally {
    process.env.PATH = PATH;
  }
}

const calls = (bin) =>
  readFileSync(join(bin, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const prPage = (prs) => [{ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: prs } } } }];
const one = (key, page) => ({ data: { repository: { pullRequest: { [key]: page } } } });

test('REQ-LED-14 a PR with over 100 comments or reviews is read in full, so a person after the first 100 is seen', () => {
  const bin = fakeGh({
    prs: prPage([
      {
        number: 7,
        headRefName: 'keel/F-1',
        headRefOid: 'h1',
        state: 'MERGED',
        comments: conn([BOT], 'c100'),
        reviews: conn([BOT], 'r100'),
      },
      { number: 8, headRefName: 'keel/F-2', headRefOid: 'h2', state: 'MERGED', comments: conn([BOT]), reviews: conn([]) },
    ]),
    comments: [one('comments', conn([BOT], 'c200')), one('comments', conn([USER]))],
    reviews: [one('reviews', conn([{ __typename: 'User', login: 'ann' }]))],
  });
  const prs = withGh(bin, (dir) => githubPrs(dir));
  assert.deepEqual(prs, [
    {
      head: 'keel/F-1',
      headOid: 'h1',
      state: 'MERGED',
      authors: [
        { type: 'Bot', login: 'linear' },
        { type: 'Bot', login: 'linear' },
        { type: 'User', login: 'brett' },
        { type: 'Bot', login: 'linear' },
        { type: 'User', login: 'ann' },
      ],
    },
    { head: 'keel/F-2', headOid: 'h2', state: 'MERGED', authors: [{ type: 'Bot', login: 'linear' }] },
  ]);
  const log = calls(bin);
  assert.deepEqual(
    log.map((c) => c.kind),
    ['prs', 'comments', 'reviews'],
    'only the PR with more pages is asked again',
  );
  for (const c of log) assert.ok(c.args.includes('--paginate') && c.args.includes('--slurp'), `${c.kind} pages`);
  const [, comments, reviews] = log;
  assert.equal(comments.vars.number, '7');
  assert.ok(comments.args.includes('number=7') && comments.args[comments.args.indexOf('number=7') - 1] === '-F', 'number is an Int');
  assert.equal(comments.vars.endCursor, 'c100', 'continues after the first page');
  assert.equal(reviews.vars.endCursor, 'r100');
  assert.match(log[0].vars.query, /comments\(first: 100\) \{ pageInfo \{ hasNextPage endCursor \}/);
  assert.match(log[0].vars.query, /reviews\(first: 100\) \{ pageInfo \{ hasNextPage endCursor \}/);
  assert.ok(log[0].vars.query.indexOf('pageInfo') < log[0].vars.query.indexOf('comments('), 'gh pages by the first pageInfo');
});

test('REQ-LED-14 a failed read of the later comments throws with gh reason, never counts the PR as untouched', () => {
  const bin = fakeGh(
    {
      prs: prPage([
        { number: 7, headRefName: 'keel/F-1', headRefOid: 'h1', state: 'MERGED', comments: conn([BOT], 'c100'), reviews: conn([]) },
      ]),
    },
    { fail: 'comments' },
  );
  assert.throws(() => withGh(bin, (dir) => githubPrs(dir)), /^Error: gh api graphql: gh: rate limited$/);
});
