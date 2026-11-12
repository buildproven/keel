import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldOutTestCommand } from '../src/gate.js';

const config = { heldOutFilesCommand: 'node --test {files}', heldOutCommand: 'npm test' };

// REQ-GATE-66: a held-out helper is copied but never handed to the runner as a test of its own.
test('REQ-GATE-66: the held-out command runs only runnable held-out tests', () => {
  const cmd = heldOutTestCommand(config, ['test/heldout-plugin-connect/curl.mjs', 'test/plugin-connect-app.test.js']);
  assert.equal(cmd, "node --test 'test/plugin-connect-app.test.js'");
});

test('REQ-GATE-66: every held-out file stays when none has a runnable name', () => {
  const cmd = heldOutTestCommand(config, ['tests/heldout.rs', 'tests/heldout-data/x.json']);
  assert.equal(cmd, "node --test 'tests/heldout.rs' 'tests/heldout-data/x.json'");
});

test('REQ-GATE-66: an explicit heldOutCommand is used unchanged', () => {
  assert.equal(heldOutTestCommand({ heldOutFilesCommand: null, heldOutCommand: 'npm test' }, ['test/heldout/a.mjs']), 'npm test');
});
