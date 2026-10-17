import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { POST_DEPLOY_PATH, POST_DEPLOY_WORKFLOW, writePostDeployWorkflow } from '../src/post-deploy.js';
import { commit, fixtureRepo, tmp } from './helpers.js';

test('REQ-PROJ-7 a Vercel project gets the post-deploy workflow once; it is never overwritten', () => {
  const dir = tmp('keel-vercel-');
  writeFileSync(join(dir, 'vercel.json'), '{}\n');
  assert.deepEqual(writePostDeployWorkflow(dir), { written: true, path: join(dir, POST_DEPLOY_PATH) });
  assert.equal(readFileSync(join(dir, POST_DEPLOY_PATH), 'utf8'), POST_DEPLOY_WORKFLOW);
  writeFileSync(join(dir, POST_DEPLOY_PATH), 'mine\n');
  assert.equal(writePostDeployWorkflow(dir).written, false);
  assert.equal(readFileSync(join(dir, POST_DEPLOY_PATH), 'utf8'), 'mine\n');
  const linked = tmp('keel-vercel-');
  mkdirSync(join(linked, '.vercel'));
  assert.equal(writePostDeployWorkflow(linked).written, true, 'a linked .vercel directory counts too');
  const plain = tmp('keel-plain-');
  assert.deepEqual(writePostDeployWorkflow(plain), { written: false, path: join(plain, POST_DEPLOY_PATH), reason: 'not a Vercel project' });
  assert.equal(existsSync(join(plain, POST_DEPLOY_PATH)), false);
});

test('REQ-PROJ-7 the workflow smoke-tests production, marks a failed deployment, and opens an auto-merging revert PR', () => {
  const w = POST_DEPLOY_WORKFLOW;
  assert.match(w, /deployment_status/);
  assert.match(w, /github\.event\.deployment\.environment == 'Production'/);
  assert.match(w, /jq -r '\.smoke \/\/ empty' keel\.json/, 'the smoke command comes from keel.json');
  assert.match(w, /KEEL_DEPLOY_URL/);
  assert.match(w, /-f state=failure/);
  assert.match(w, /git revert --no-commit/);
  assert.match(w, /gh pr merge "\$url" --auto --squash/);
  assert.ok(!/\|\| true/.test(w), 'no silent fallbacks');
  // Event fields reach the shell only through env, never inline in a run script (actionlint's injection rule).
  for (const line of w.split('\n').filter((l) => l.includes('${{ github.event'))) assert.match(line, /^\s+(if|ref|[A-Z_]+):/, line);
  const lint = spawnSync('actionlint', ['-'], { input: w, encoding: 'utf8' });
  // REQ-PROJ-7: actionlint checks the workflow wherever it is installed (it is not on the CI image).
  if (!lint.error) assert.equal(lint.status, 0, `${lint.stdout}${lint.stderr}`);
});

test('REQ-PROJ-7 REQ-CFG-1 smoke defaults to none and must be a non-empty command string', () => {
  assert.equal(DEFAULTS.smoke, null);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  for (const bad of ['', ' ', 5, ['curl']]) assert.throws(() => loadConfig(dir, at({ smoke: bad })), /smoke/);
  assert.equal(loadConfig(dir, at({ smoke: 'curl -fsS "$KEEL_DEPLOY_URL"' })).smoke, 'curl -fsS "$KEEL_DEPLOY_URL"');
});
