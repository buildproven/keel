import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST_DEPLOY_WORKFLOW as w } from '../src/post-deploy.js';

test('REQ-PROJ-8 each run gets its own concurrency group, so a later status event cannot cancel a pending smoke test', () => {
  assert.match(w, /concurrency:\n {2}group: keel-post-deploy-\$\{\{ github\.run_id \}\}\n/);
  assert.ok(!/group: keel-post-deploy\n/.test(w), 'no repository-wide group');
});

test('REQ-PROJ-8 without KEEL_BOT_TOKEN the run says the revert PR needs a human to start its CI', () => {
  const revert = w.split('\n      - name: ').find((x) => x.startsWith('Revert the change'));
  assert.match(revert, /HAS_BOT_TOKEN: \$\{\{ secrets\.KEEL_BOT_TOKEN != '' \}\}/);
  assert.match(revert, /::error::no KEEL_BOT_TOKEN secret: CI will not start on the revert PR/);
});
