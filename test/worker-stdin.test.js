import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { workerCommand } from '../src/workers.js';

const big = 'x'.repeat(200 * 1024);

test('REQ-RUN-31 claude and codex get the prompt on stdin, never as an argument, so a large prompt fits', () => {
  for (const provider of ['claude', 'codex']) {
    const { args, input } = workerCommand({ provider, model: 'm', effort: 'high' }, big, DEFAULTS);
    assert.equal(input, big, `${provider} reads the prompt from stdin`);
    assert.ok(
      args.every((a) => a.length < 1000),
      `${provider} argv holds no prompt`,
    );
  }
  assert.equal(workerCommand({ provider: 'codex', model: 'm', effort: 'high' }, 'P', DEFAULTS).args.at(-1), '-');
});
