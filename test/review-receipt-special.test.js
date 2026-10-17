import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const gateUrl = new URL('../src/gate.js', import.meta.url).href;
const helpersUrl = new URL('./helpers.js', import.meta.url).href;
const configUrl = new URL('../src/config.js', import.meta.url).href;

// The gate runs in a child with a timeout: reading a FIFO blocks the whole process, so an in-process test would hang.
test('REQ-GATE-23 a directory or FIFO named like a receipt is not read: the gate neither throws nor hangs', () => {
  const script = `
    import { mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { execFileSync } from 'node:child_process';
    import { parseCard } from ${JSON.stringify(configUrl)};
    import { gate } from ${JSON.stringify(gateUrl)};
    import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from ${JSON.stringify(helpersUrl)};
    const card = parseCard('# T-1: test card\\nkind: bug\\nsize: S\\n');
    const { dir, base } = fixtureRepo();
    commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
    const receiptDir = tmp('keel-receipts-');
    mkdirSync(join(receiptDir, 'T-1-dir.json'));
    execFileSync('mkfifo', [join(receiptDir, 'T-1-fifo.json')]);
    const reviewer = { provider: 'exec', family: 'codex', model: 'exec-review', effort: 'high',
      command: ['node', '-e', "require('fs').readFileSync(0); console.log('VERDICT: pass')"] };
    const r = gate({ repo: dir, base, card, config: fixtureConfig({ review: true }), receiptDir, reviewer });
    console.log('PASS=' + r.pass);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: join(import.meta.dirname, '..'),
  });
  assert.equal(r.error?.code, undefined, 'the gate hung on the FIFO');
  assert.match(r.stdout, /PASS=true/, r.stderr);
});
