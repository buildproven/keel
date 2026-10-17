import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { tmp } from './helpers.js';

// REQ-TRACE-5: tmp() dirs were never removed; on 2026-10-14 TMPDIR held ~3,500 keel-* dirs (BUI-1214).
const helpers = new URL('./helpers.js', import.meta.url).href;
const child = (exitCode) => `
  import { existsSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { tmp, fixtureRepo } from ${JSON.stringify(helpers)};
  const dir = tmp('keel-leak-');
  writeFileSync(join(dir, 'f'), 'x');
  fixtureRepo();
  if (!existsSync(dir)) process.exit(9);
  process.exit(${exitCode});
`;

for (const exitCode of [0, 3]) {
  test(`REQ-TRACE-5 a test process that calls tmp() and exits with ${exitCode} leaves no dir in TMPDIR`, () => {
    const tmpDir = tmp('keel-tmpdir-');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child(exitCode)], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmpDir },
    });
    assert.equal(r.status, exitCode, r.stderr);
    assert.deepEqual(readdirSync(tmpDir), []);
  });
}
