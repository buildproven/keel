import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linearHttpClient } from '../src/linear-http.js';

/** Run createIssue against canned Linear responses; the rollback delete answers `deleteResponse`. */
async function fileWithRejectedRelation(deleteResponse) {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const responses = [
    { data: { issue: { team: { id: 'team-1' }, project: { id: 'proj-1' } } } },
    { data: { issueCreate: { success: true, issue: { identifier: 'BUI-203' } } } },
    { data: { issueRelationCreate: { success: false } } },
    deleteResponse,
  ];
  let n = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => responses[n++] });
  try {
    return await linearHttpClient()
      .createIssue('BUI-7', { title: 'T', description: 'D', priority: 4, blockedBy: ['BUI-7'] })
      .then(
        () => assert.fail('createIssue should reject'),
        (e) => e.message,
      );
  } finally {
    globalThis.fetch = saved;
  }
}

test('REQ-LINEAR-28 a rollback delete Linear answers with success: false is reported as not deleted, naming the issue to remove', async () => {
  const message = await fileWithRejectedRelation({ data: { issueDelete: { success: false } } });
  assert.match(message, /BUI-203 blocked by BUI-7/);
  assert.match(message, /could not delete BUI-203/);
  assert.doesNotMatch(message, /deleted BUI-203 so the next poll files it again/);
});

test('REQ-LINEAR-28 a rollback delete that fails with a GraphQL error keeps the relation error and names the issue to remove', async () => {
  const message = await fileWithRejectedRelation({ errors: [{ message: 'not permitted' }] });
  assert.match(message, /BUI-203 blocked by BUI-7/);
  assert.match(message, /could not delete BUI-203.*not permitted/);
});
