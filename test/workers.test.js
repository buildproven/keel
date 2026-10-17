import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { classifyFailure, parseUsage, workerCommand } from '../src/workers.js';

test('REQ-RUN-2 claude tier passes model, effort, and permission mode', () => {
  const { cmd, args } = workerCommand({ provider: 'claude', model: 'claude-sonnet-5', effort: 'low' }, 'P', DEFAULTS);
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'json',
    '--model',
    'claude-sonnet-5',
    '--effort',
    'low',
    '--permission-mode',
    'auto',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ]);
});

test('REQ-RUN-2 codex tier passes model, reasoning effort, and workspace-write sandbox', () => {
  const { cmd, args } = workerCommand({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' }, 'P', DEFAULTS);
  assert.equal(cmd, 'codex');
  assert.deepEqual(args, ['exec', '--json', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high', '-s', 'workspace-write', '-']);
});

test('REQ-RUN-8 appends per-provider workerArgs to the worker command', () => {
  const config = { ...DEFAULTS, workerArgs: { claude: ['--strict-mcp-config'], codex: ['--skip-git-repo-check'] } };
  assert.equal(workerCommand({ provider: 'claude', model: 'm', effort: 'low' }, 'P', config).args.at(-1), '--strict-mcp-config');
  const codex = workerCommand({ provider: 'codex', model: 'm', effort: 'low' }, 'P', config).args;
  assert.deepEqual(codex.slice(-2), ['--skip-git-repo-check', '-'], 'stdin prompt marker stays the last codex argument');
});

test('REQ-RUN-2 rejects an unknown provider and an exec tier without a command', () => {
  assert.throws(() => workerCommand({ provider: 'gemini' }, 'P', DEFAULTS), /unknown provider/);
  assert.throws(() => workerCommand({ provider: 'exec' }, 'P', DEFAULTS), /command/);
});

test('REQ-LED-1 parses Claude usage: cache writes are recorded apart from uncached input', () => {
  const out = JSON.stringify({
    is_error: false,
    total_cost_usd: 0.12,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 },
  });
  assert.deepEqual(parseUsage('claude', out), { usage: { in: 10, cacheWrite: 5, out: 7, cached: 100 }, cost: 0.12, isError: false });
});

test('REQ-LED-1 normalizes Codex usage: cached input is split out of input', () => {
  const out = [
    'banner line',
    '{"type":"thread.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":9}}',
    '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":1}}',
  ].join('\n');
  assert.deepEqual(parseUsage('codex', out), { usage: { in: 110, out: 10, cached: 40 }, cost: null, isError: false });
});

test('REQ-RUN-9 a Codex turn.failed event marks the attempt as an error', () => {
  assert.equal(parseUsage('codex', '{"type":"turn.failed","error":{"message":"x"}}').isError, true);
});

test('REQ-RUN-6 classifies quota, auth, and other worker failures', () => {
  assert.equal(classifyFailure('Error: 429 Too Many Requests'), 'quota');
  assert.equal(classifyFailure("You've hit your usage limit"), 'quota');
  assert.equal(classifyFailure('Not logged in · Please run /login'), 'auth');
  assert.equal(classifyFailure('TypeError: x is undefined'), 'error');
});

test('REQ-RUN-11 classifies transient network/service failures separately from a real model/code error', () => {
  // A stronger model is no more likely to fix a dropped connection than a cheap one — these must not
  // trigger tier escalation, unlike a genuine 'error' classification.
  assert.equal(classifyFailure('Error: getaddrinfo ENOTFOUND api.anthropic.com'), 'network');
  assert.equal(classifyFailure('connect ECONNREFUSED 127.0.0.1:443'), 'network');
  assert.equal(classifyFailure('read ECONNRESET'), 'network');
  assert.equal(classifyFailure('Error: socket hang up'), 'network');
  assert.equal(classifyFailure('fetch failed'), 'network');
  assert.equal(classifyFailure('Internal Server Error (500)'), 'network');
  assert.equal(classifyFailure('Bad Gateway (502)'), 'network');
  assert.equal(classifyFailure('Service Unavailable (503)'), 'network');
  assert.equal(classifyFailure('Gateway Timeout (504)'), 'network');
  assert.equal(classifyFailure('request failed with status code 502'), 'network');
  // A real application error must not be reclassified just because it mentions an unrelated number.
  assert.equal(classifyFailure('TypeError: cannot read property of undefined at line 500'), 'error');
  assert.equal(classifyFailure('Test failed: expected 500 items, got 503'), 'error');
});

test('REQ-LED-2 reports missing usage as null, never zero', () => {
  assert.equal(parseUsage('claude', 'not json').usage, null);
  assert.equal(parseUsage('codex', '{"type":"thread.started"}').usage, null);
  assert.equal(parseUsage('exec', '{"result":"ok"}').usage, null);
});
