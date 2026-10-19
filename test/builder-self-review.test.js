import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { buildPrompt } from '../src/run.js';
import { fixtureConfig } from './helpers.js';

for (const kind of ['bug', 'feature', 'refactor', 'ui', 'infra', 'chore']) {
  test(`REQ-RUN-43 the ${kind} prompt asks for a hostile self-review of the diff before finishing`, () => {
    const prompt = buildPrompt(parseCard(`# T-1: card\nkind: ${kind}\nsize: S\n`), fixtureConfig(), null);
    assert.match(prompt, /review your diff as a hostile reviewer/i);
    for (const edge of [/input edge cases/i, /saved or legacy data/i, /error and catch paths/i, /external API limits/i])
      assert.match(prompt, edge);
    assert.match(prompt, /a test that fails without your change/i);
  });
}
