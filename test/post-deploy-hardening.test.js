import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST_DEPLOY_WORKFLOW as w } from '../src/post-deploy.js';

const step = (name) => w.split('\n      - name: ').find((x) => x.startsWith(name));

test('REQ-PROJ-8 the smoke command comes from the default branch, and checkout persists no credentials', () => {
  assert.match(w, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.ok(!/ref: \$\{\{ github\.event\.deployment\.sha \}\}/.test(w), 'never check out the deployed commit to read a command');
  assert.match(w, /persist-credentials: false/);
  assert.match(w, /permissions:\n {2}contents: read\n/, 'read-only by default');
});

test('REQ-PROJ-8 only the respond job writes, and it runs only on a failed smoke test', () => {
  assert.match(
    w,
    /respond:\n {4}needs: verify\n {4}if: needs\.verify\.outputs\.smoke == 'fail'[\s\S]*?contents: write\n {6}deployments: write\n {6}pull-requests: write/,
  );
});

test('REQ-PROJ-8 no Vercel rollback: it turns off auto-assignment of production domains, so the fix is a revert that deploys normally', () => {
  assert.ok(!/vercel@/.test(w));
  assert.ok(!/VERCEL_TOKEN/.test(w));
});

test('REQ-PROJ-8 a smoke-failed deployment gets a failure status', () => {
  assert.match(
    step('Mark the deployment as failed'),
    /gh api -X POST "repos\/\$REPO\/deployments\/\$DEPLOYMENT_ID\/statuses" -f state=failure/,
  );
});

test('REQ-PROJ-8 the revert sets up git auth first, reverts only a commit on the default branch, and carries the keel subject', () => {
  const revert = step('Revert the change');
  assert.ok(revert.indexOf('gh auth setup-git') < revert.indexOf('git fetch'));
  assert.match(revert, /git merge-base --is-ancestor "\$SHA" "origin\/\$base"/);
  assert.match(revert, /git commit -m "revert: \$short failed the post-deploy smoke test"/);
});

test('REQ-PROJ-8 a failed smoke test always leaves the run red', () => {
  assert.match(w, /- name: Mark the incident\n {8}if: always\(\)\n[\s\S]*?exit 1/);
});

test('REQ-PROJ-8 the revert runs first; marking the deployment runs after it on always(), so a status error cannot skip recovery', () => {
  assert.ok(w.indexOf('- name: Revert the change') < w.indexOf('- name: Mark the deployment as failed'));
  assert.match(w, /- name: Mark the deployment as failed\n {8}if: always\(\)/);
});
