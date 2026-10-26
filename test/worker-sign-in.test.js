import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { describeStop, run } from '../src/run.js';
import { runWorker } from '../src/workers.js';

process.env.KEEL_STATE_DIR = tmp('keel-state-');

const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const SECRETS = { [TOKEN]: 'oauth-secret', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', LINEAR_API_KEY: 'l', CODEX_API_KEY: 'c' };

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};

/** A dir with fake `claude` and `codex` CLIs that print, as their result line, which of SECRETS they received. */
function fakeClis(body = null) {
  const bin = tmp('keel-clis-');
  const probe =
    body ??
    `require('fs').readFileSync(0); const seen = ${JSON.stringify(Object.keys(SECRETS))}.filter((n) => process.env[n] !== undefined);
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, seen }));`;
  for (const name of ['claude', 'codex']) {
    const file = join(bin, name);
    writeFileSync(file, `#!${process.execPath}\n${probe}\n`);
    chmodSync(file, 0o755);
  }
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

const seen = (r) => JSON.parse(r.output.trim().split('\n').at(-1)).seen;
const worker = (tier) => withEnv({ ...SECRETS, ...fakeClis() }, () => runWorker(tier, 'prompt', process.cwd(), fixtureConfig()));

test('REQ-RUN-50 a claude worker receives CLAUDE_CODE_OAUTH_TOKEN and no other secret-looking name', () => {
  const r = worker({ provider: 'claude', model: 'm', effort: 'low' });
  assert.equal(r.status, 'ok', r.output);
  assert.deepEqual(seen(r), [TOKEN]);
});

test('REQ-RUN-50 a codex worker does not receive CLAUDE_CODE_OAUTH_TOKEN or any API key', () => {
  const r = worker({ provider: 'codex', model: 'm', effort: 'low' });
  assert.deepEqual(seen(r), []);
});

test('REQ-RUN-50 an exec worker, even of the claude family, does not receive CLAUDE_CODE_OAUTH_TOKEN', () => {
  const r = worker({ provider: 'exec', family: 'claude', model: 'm', effort: 'low', command: ['claude'] });
  assert.deepEqual(seen(r), []);
});

test('REQ-RUN-50 configured checks and the test command do not receive CLAUDE_CODE_OAUTH_TOKEN', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  const check = `node -e "process.exit(process.env.${TOKEN} ? 1 : 0)"`;
  const config = fixtureConfig({ checks: { env: check }, testCommand: check });
  const card = parseCard('# T-1: env\nkind: chore\nsize: S\n');
  const r = withEnv({ [TOKEN]: 'oauth-secret' }, () => gate({ repo: dir, base, card, config }));
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
});

const NOT_LOGGED_IN = `require('fs').readFileSync(0); console.error('Not logged in · Please run /login'); process.exit(1);`;
const authRun = (token) => {
  const { dir } = fixtureRepo();
  const card = parseCard('# T-2: sign in\nkind: chore\nsize: S\n');
  const config = fixtureConfig({ tiers: [{ provider: 'claude', model: 'm', effort: 'low' }] });
  return withEnv({ [TOKEN]: token, ...fakeClis(NOT_LOGGED_IN) }, () => run({ repo: dir, card, config }));
};

test('REQ-RUN-50 a claude worker that cannot sign in, with CLAUDE_CODE_OAUTH_TOKEN unset, stops naming the fix', () => {
  const r = authRun(undefined);
  assert.equal(r.stopped, 'auth');
  assert.match(r.failure, /CLAUDE_CODE_OAUTH_TOKEN \(made once by `claude setup-token`\)/);
  assert.match(describeStop(r), /claude setup-token/);
});

test('REQ-RUN-50 with CLAUDE_CODE_OAUTH_TOKEN set, an auth stop does not tell the user to set it', () => {
  const r = authRun('oauth-secret');
  assert.equal(r.stopped, 'auth');
  assert.doesNotMatch(r.failure, /setup-token/);
});

test('REQ-RUN-50 workerEnvAllow cannot pass CLAUDE_CODE_OAUTH_TOKEN to a codex worker or a check', () => {
  const config = fixtureConfig({ workerEnvAllow: [TOKEN] });
  const r = withEnv({ ...SECRETS, ...fakeClis() }, () =>
    runWorker({ provider: 'codex', model: 'm', effort: 'low' }, 'p', process.cwd(), config),
  );
  assert.deepEqual(seen(r), []);
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  const check = `node -e "process.exit(process.env.${TOKEN} ? 1 : 0)"`;
  const gated = withEnv({ [TOKEN]: 'oauth-secret' }, () =>
    gate({
      repo: dir,
      base,
      card: parseCard('# T-3: env\nkind: chore\nsize: S\n'),
      config: { ...config, checks: { env: check }, testCommand: check },
    }),
  );
  assert.equal(gated.pass, true, JSON.stringify(gated.results, null, 2));
});

test('REQ-RUN-50 every claude worker call that fails auth without the token names the fix in its output', () => {
  const r = withEnv({ [TOKEN]: undefined, ...fakeClis(NOT_LOGGED_IN) }, () =>
    runWorker({ provider: 'claude', model: 'm', effort: 'low' }, 'p', process.cwd(), fixtureConfig()),
  );
  assert.equal(r.status, 'auth');
  assert.match(r.output, /fix: run `claude auth status`/);
});
