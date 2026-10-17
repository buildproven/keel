import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// REQ-TRACE-4: a test that reaches the real claude or codex CLI spends the shared provider window on every `npm test`
// (BUI-1209: a CLI gate test with review on drained the Codex window on 2026-10-13).
test('REQ-TRACE-4 under npm test, claude and codex on PATH are stand-ins that fail at once', () => {
  for (const cli of ['claude', 'codex']) {
    const r = spawnSync(cli, ['--version'], { encoding: 'utf8' });
    assert.equal(r.status, 97, `${cli} must be the test stand-in, got ${r.status ?? r.error?.code}`);
    assert.match(r.stderr, /real model CLI blocked in keel tests/);
  }
});
