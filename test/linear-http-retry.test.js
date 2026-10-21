import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { linearHttpClient } from '../src/linear-http.js';

const originalFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = 0;
  process.env.LINEAR_API_KEY = 'lin_api_test';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_API_KEY;
});

// What undici throws when the request body is written to a pooled socket the server already closed.
const deadSocket = (code = 'EPIPE') =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`write ${code}`), { code }) });
const ok = { ok: true, json: async () => ({ data: { commentCreate: { success: true } } }) };
const state = { ok: true, json: async () => ({ data: { issue: { state: { type: 'started' } } } }) };

/** A fetch that plays `steps` in order: an Error is thrown, anything else is the response. */
function stubFetch(steps) {
  globalThis.fetch = async () => {
    const step = steps[calls++];
    if (step instanceof Error) throw step;
    return step;
  };
}

test('REQ-LINEAR-36 a query that fails on a dead pooled connection is sent again and succeeds', async () => {
  for (const code of ['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']) {
    calls = 0;
    stubFetch([deadSocket(code), state]);
    assert.equal(await linearHttpClient().stateType('BUI-1'), 'started', code);
    assert.equal(calls, 2, code);
  }
});

test('REQ-LINEAR-36 a mutation is sent again only after EPIPE, when its body never reached Linear', async () => {
  stubFetch([deadSocket('EPIPE'), ok]);
  await linearHttpClient().comment('BUI-1', 'hello');
  assert.equal(calls, 2);
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']) {
    calls = 0;
    stubFetch([deadSocket(code), ok]);
    await assert.rejects(() => linearHttpClient().comment('BUI-1', 'hello'), /fetch failed/, code);
    assert.equal(calls, 1, `${code}: a reset may come after Linear applied the comment`);
  }
});

test('REQ-LINEAR-36 when every try fails on a dead connection, the last error is thrown', async () => {
  const last = deadSocket('ECONNRESET');
  stubFetch([deadSocket(), deadSocket(), last, state]);
  await assert.rejects(
    () => linearHttpClient().stateType('BUI-1'),
    (e) => e === last,
  );
  assert.equal(calls, 3, 'one request and two retries');
});

test('REQ-LINEAR-36 an HTTP error, a GraphQL error, or another network error is not retried', async () => {
  stubFetch([{ ok: false, status: 500, json: async () => ({ errors: [{ message: 'boom' }] }) }, ok]);
  await assert.rejects(() => linearHttpClient().comment('BUI-1', 'hello'), /500|boom/);
  assert.equal(calls, 1);
  calls = 0;
  stubFetch([{ ok: true, json: async () => ({ errors: [{ message: 'usage limit exceeded' }] }) }, ok]);
  await assert.rejects(() => linearHttpClient().comment('BUI-1', 'hello'), /usage limit exceeded/);
  assert.equal(calls, 1);
  calls = 0;
  stubFetch([deadSocket('ENOTFOUND'), ok]);
  await assert.rejects(() => linearHttpClient().comment('BUI-1', 'hello'), /fetch failed/);
  assert.equal(calls, 1);
});
