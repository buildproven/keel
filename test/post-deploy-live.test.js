import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST_DEPLOY_WORKFLOW as w } from '../src/post-deploy.js';

const step = (name) => w.split('\n      - name: ').find((x) => x.startsWith(name));

test('REQ-PROJ-8 the revert targets exactly the deployed commit; no guess about which deployment is live', () => {
  assert.ok(!/keel_live_deployment|keel_previous_good_url/.test(w), 'no deployment-selection heuristics');
  const revert = step('Revert the change');
  assert.match(revert, /SHA: \$\{\{ github\.event\.deployment\.sha \}\}/);
  assert.match(revert, /git revert --no-commit "\$SHA"/);
  assert.match(revert, /git revert --no-commit -m 1 "\$SHA"/, 'a merge commit reverts against its first parent');
});
