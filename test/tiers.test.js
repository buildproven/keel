import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';

// Each ID below was confirmed with one live call on 2026-09-30 (BUI-1005): the CLI accepted it and
// reported that same model in `modelUsage`. Change this list only after repeating that check.
test('REQ-RUN-2 REQ-RUN-35 the default ladder is Sonnet 5.5 high, Opus 5.5 high, Codex sol high', () => {
  assert.deepEqual(
    DEFAULTS.tiers.map((t) => `${t.provider}:${t.model}:${t.effort}`),
    ['claude:claude-sonnet-5-5:high', 'claude:claude-opus-5-5:high', 'codex:gpt-5.6-sol:high'],
  );
});
