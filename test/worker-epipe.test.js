import { test } from 'node:test';
import assert from 'node:assert';
import { runWorker } from '../src/workers.js';

const config = { workerTimeoutSec: 30, workerEnvAllow: [] };

test('REQ-RUN-29 a worker that exits before reading its prompt is classified by its output, not spawn-error', () => {
  const script = "console.error('Not logged in. Please log in.'); process.exit(1);";
  const tier = { provider: 'exec', command: [process.execPath, '-e', script] };
  const r = runWorker(tier, 'x'.repeat(8 * 1024 * 1024), process.cwd(), config);
  assert.strictEqual(r.status, 'auth');
});
