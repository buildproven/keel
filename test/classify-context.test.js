import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/run.js';
import { classifyFailure } from '../src/workers.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';
import { parseCard } from '../src/config.js';
import { fileURLToPath } from 'node:url';
import { beforeEach } from 'node:test';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

test('REQ-RUN-6 a bare 401 or 429 (a stack-trace line, a test file line) is not auth or quota', () => {
  assert.equal(classifyFailure('TypeError: x is undefined\n    at parse (/w/src/app.js:401:12)'), 'error');
  assert.equal(classifyFailure('AssertionError: expected 3\n    at Context.<anonymous> (test/x.test.js:429:7)'), 'error');
  assert.equal(classifyFailure('expected 401 rows, got 429'), 'error');
  assert.equal(classifyFailure('AssertionError: 429 !== 430'), 'error');
  assert.equal(classifyFailure('TypeError: 401 is not a function'), 'error');
});

test('REQ-RUN-6 test names that mention rate limits, quotas, or authorization are not auth or quota', () => {
  assert.equal(classifyFailure('FAIL test/limits.test.js > rate limit middleware returns 200 for first call'), 'error');
  assert.equal(classifyFailure('1 failing: quota calculator rounds down'), 'error');
  assert.equal(classifyFailure('✖ returns unauthorized for a bad token'), 'error');
  assert.equal(classifyFailure('RecursionError: recursion limit reached'), 'error');
  // The gate review's examples (BUI-1191): test text about the app's own limits and statuses.
  for (const t of [
    '✖ rate limiter returns 429 Too Many Requests',
    'Error: expected 429 "Too Many Requests", got 200 "OK"',
    '✖ enforces the usage limit per user',
    '✖ marks the client as rate limited',
    'AssertionError: expected status code 401, got 200',
    'expected status: 401 but got 200',
    '✖ redirects to /login when not logged in',
    '✖ shows "please log in" to guests',
    '✖ returns 401 Unauthorized for a bad token',
    '    Error: 401 Unauthorized\n      at fetchJson (src/api.js:12:11)',
    'Error: 401 Unauthorized\n    at fetchJson (src/api.js:12:11)',
    '    Error: 429 Too Many Requests\n      at fetchJson (src/api.js:12:11)',
    'Error: 429 Too Many Requests from the mock server',
  ])
    assert.equal(classifyFailure(t), 'error', t);
});

test('REQ-RUN-6 provider limit and login messages as the CLIs print them still classify', () => {
  for (const q of [
    'Error: 429 Too Many Requests',
    "You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.",
    'Claude AI usage limit reached|1760400000',
    '5-hour limit reached ∙ resets 3pm (America/Chicago)',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
    'stream error: exceeded retry limit, last status: 429 Too Many Requests',
    'Quota exceeded. Check your plan and billing details.',
    'You exceeded your current quota, please check your plan and billing details.',
    'rate_limit_exceeded',
    'insufficient_quota',
    'Rate limit reached for gpt-5 in organization org-x',
    'Error: usage limit reached, try again later',
  ])
    assert.equal(classifyFailure(q), 'quota', q);
  for (const a of [
    'Not logged in · Please run /login',
    'Not logged in. Please log in.',
    'Invalid API key · Please run /login',
    'unexpected status 401 Unauthorized: Missing bearer authentication',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
  ])
    assert.equal(classifyFailure(a), 'auth', a);
});

test('REQ-RUN-3 a worker that crashes with a stack trace at line 401 escalates, it does not stop the run as auth', () => {
  const { dir } = fixtureRepo();
  const crash = {
    provider: 'exec',
    family: 'claude',
    model: 'exec-crash',
    effort: 'low',
    command: [
      'node',
      '-e',
      "require('fs').readFileSync(0); console.error('TypeError: boom\\n    at f (/w/src/app.js:401:3)'); process.exit(1)",
    ],
  };
  const good = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
  const card = parseCard('# T-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const r = run({ repo: dir, card, config: fixtureConfig({ tiers: [crash, good] }) });
  assert.notEqual(r.stopped, 'auth');
  assert.equal(r.pass, true, r.failure);
});
