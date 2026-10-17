// REQ-PROJ-5: prove the gate (red proof pass and fail) on non-JS languages — no keel code is JS-specific.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { commit, fixtureConfig, fixtureRepo } from './helpers.js';

const card = (header = 'kind: bug\nsize: S') => parseCard(`# T-1: test card\n${header}\n`);
const rules = (receipt) => receipt.results.flatMap((r) => r.problems.map((p) => p.rule));

// REQ-PROJ-5: locally a missing toolchain skips; in CI it must fail, or the proof silently vanishes.
const skipUnlessCi = (available, reason) => (available ? false : process.env.CI ? false : reason);

let pytestAvailable;
try {
  execFileSync('python3', ['-c', 'import pytest'], { stdio: 'ignore' });
  pytestAvailable = true;
} catch {
  pytestAvailable = false;
}
let goAvailable;
try {
  execFileSync('go', ['version'], { stdio: 'ignore' });
  goAvailable = true;
} catch {
  goAvailable = false;
}

test(
  'REQ-PROJ-5 gate proves a Python/pytest regression: fails on base, passes on head',
  { skip: skipUnlessCi(pytestAvailable, 'python3 -m pytest not available') },
  () => {
    const pyConfig = fixtureConfig({
      checks: { test: 'python3 -m pytest -q' },
      testCommand: 'python3 -m pytest -q',
      testGlobs: ['test_*.py'],
    });
    const { dir, base } = fixtureRepo({
      'add.py': 'def add(a, b):\n    return a - b\n',
      'test_basic.py': 'def test_placeholder():\n    assert True\n',
    });
    // Bug fix with no test: no proof.
    commit(dir, { 'add.py': 'def add(a, b):\n    return a + b\n' });
    const noTest = gate({ repo: dir, base, card: card(), config: pyConfig });
    assert.deepEqual(rules(noTest), ['no-test-changed']);

    commit(dir, { 'test_add.py': 'from add import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n' });
    const passed = gate({ repo: dir, base, card: card(), config: pyConfig });
    assert.equal(passed.pass, true, JSON.stringify(passed.results, null, 2));
  },
);

test(
  'REQ-PROJ-5 gate rejects a Python test that also passes on the buggy base',
  { skip: skipUnlessCi(pytestAvailable, 'python3 -m pytest not available') },
  () => {
    const pyConfig = fixtureConfig({
      checks: { test: 'python3 -m pytest -q' },
      testCommand: 'python3 -m pytest -q',
      testGlobs: ['test_*.py'],
    });
    const { dir, base } = fixtureRepo({
      'add.py': 'def add(a, b):\n    return a - b\n',
      'test_basic.py': 'def test_placeholder():\n    assert True\n',
    });
    commit(dir, { 'test_trivial.py': 'def test_trivial():\n    assert 1 == 1\n', 'add.py': 'def add(a, b):\n    return a + b\n' });
    assert.deepEqual(rules(gate({ repo: dir, base, card: card(), config: pyConfig })), ['test-passes-on-base']);
  },
);

test(
  'REQ-PROJ-5 gate proves a Go regression: fails on base, passes on head',
  { skip: skipUnlessCi(goAvailable, 'go toolchain not available') },
  () => {
    const goConfig = fixtureConfig({
      checks: { vet: 'go vet ./...', test: 'go test ./...' },
      testCommand: 'go test ./...',
      testGlobs: ['**/*_test.go'],
    });
    const { dir, base } = fixtureRepo({
      'go.mod': 'module keelfixture\n\ngo 1.21\n',
      'add.go': 'package keelfixture\n\nfunc Add(a, b int) int {\n\treturn a - b\n}\n',
    });
    commit(dir, {
      'add_test.go':
        'package keelfixture\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("wrong sum")\n\t}\n}\n',
      'add.go': 'package keelfixture\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n',
    });
    const passed = gate({ repo: dir, base, card: card(), config: goConfig });
    assert.equal(passed.pass, true, JSON.stringify(passed.results, null, 2));
  },
);
