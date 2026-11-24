import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findBypassMarkers,
  findSkipMarkers,
  outOfScope,
  pyprojectToolSectionsChanged,
  scriptPaths,
  scriptsChanged,
  testShape,
} from '../src/scan.js';

const lines = (...texts) => texts.map((text, i) => ({ path: 'f.js', line: i + 1, text }));

test('REQ-GATE-6 finds skip and focus markers', () => {
  // Markers are built from parts so Keel's own gate does not flag these fixture lines.
  const [skip, only, x] = ['skip', 'only', 'x'];
  const found = findSkipMarkers(
    lines(`it.${skip}("x", () => {})`, `test.${only}("y")`, `${x}it("z")`, `@pytest.mark.${skip}`, 'it("ok", () => {})'),
  );
  assert.deepEqual(
    found.map((f) => f.line),
    [1, 2, 3, 4],
  );
  assert.equal(found[0].rule, 'skip-marker');
});

test('REQ-GATE-8 finds lint, type, and hook bypass markers', () => {
  const found = findBypassMarkers(
    lines(
      '// eslint-disable-next-line no-console',
      'const x: any = 1;',
      'y as any',
      '// @ts-ignore',
      'import os  # type: ignore',
      'git commit --no-verify',
      'const company = anyValue;',
    ),
  );
  assert.deepEqual(
    found.map((f) => f.line),
    [1, 2, 3, 4, 5, 6],
  );
});

test('REQ-GATE-9 reports paths outside the allowed globs, none when no globs', () => {
  assert.deepEqual(outOfScope(['src/a.js', 'test/a.test.js', 'README.md'], ['src/**', 'test/**']), ['README.md']);
  assert.deepEqual(outOfScope(['anything.js'], []), []);
});

test('REQ-GATE-4 detects package.json script changes, ignores other fields', () => {
  const pkg = (scripts, extra = {}) => JSON.stringify({ name: 'x', ...extra, scripts });
  assert.equal(scriptsChanged(pkg({ test: 'vitest' }), pkg({ test: 'vitest' }, { dependencies: { a: '1' } })), false);
  assert.equal(scriptsChanged(pkg({ test: 'vitest' }), pkg({ test: 'true' })), true);
  assert.equal(scriptsChanged(null, pkg({ test: 'x' })), true);
});

// machine-setup 2026-11-16: a new mcp-servers/raindrop/package.json with no scripts failed package-scripts-changed.
test('REQ-GATE-4 a package.json added or removed without scripts changes no scripts', () => {
  assert.equal(scriptsChanged(null, JSON.stringify({ name: 'x', dependencies: { a: '1' } })), false);
  assert.equal(scriptsChanged(JSON.stringify({ name: 'x' }), null), false);
  assert.equal(scriptsChanged(JSON.stringify({ name: 'x', scripts: { test: 'x' } }), null), true);
});

test('REQ-GATE-4 locks only files called by the scripts the checks run', () => {
  const pkg = JSON.stringify({
    scripts: { test: 'node scripts/check.mjs', pretest: 'sh ./tools/prep.sh', gate: 'node bin/keel.js gate', lint: 'eslint .' },
  });
  assert.deepEqual(scriptPaths(pkg, ['npm test', 'npm run lint']).sort(), ['scripts/check.mjs', 'tools/prep.sh']);
  assert.deepEqual(scriptPaths(null, ['node test/run.mjs --fast']), ['test/run.mjs']);
  assert.deepEqual(scriptPaths(pkg, ['pnpm gate']), ['bin/keel.js']);
});

test('REQ-PROJ-3 finds skip markers in Go, Rust, Ruby, Java/Kotlin, C#, PHP', () => {
  // Built from parts so Keel's own gate does not flag these fixture lines.
  const [skip, ignore, disabled, markSkipped] = ['Skip', 'ignore', 'Disabled', 'markTestSkipped'];
  const found = findSkipMarkers(
    lines(
      `t.${skip}("reason")`,
      `#[${ignore}]`,
      'skip "reason" do',
      `@${disabled}`,
      `[${ignore.replace('i', 'I')}("reason")]`,
      `$this->${markSkipped}('reason');`,
      'it "does a thing" do',
    ),
  );
  assert.deepEqual(
    found.map((f) => f.line),
    [1, 2, 3, 4, 5, 6],
  );
});

test('REQ-PROJ-3 finds bypass markers in Go, Rust, Ruby, Java, C#, PHP, shell', () => {
  const found = findBypassMarkers(
    lines(
      '//nolint',
      '#[allow(dead_code)]',
      '# rubocop:disable Style/Foo',
      '@SuppressWarnings("unchecked")',
      '#pragma warning disable CS0168',
      '// @phpstan-ignore-next-line',
      '# shellcheck disable=SC2086',
      'echo hello',
    ),
  );
  assert.deepEqual(
    found.map((f) => f.line),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test('REQ-PROJ-4 identifies only the test/lint/type tool sections of pyproject.toml', () => {
  const before = '[project]\nname = "x"\ndependencies = ["requests"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
  const afterDepOnly = '[project]\nname = "x"\ndependencies = ["requests", "httpx"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
  const afterToolChanged = '[project]\nname = "x"\ndependencies = ["requests"]\n\n[tool.pytest.ini_options]\naddopts = "-q -x"\n';
  assert.equal(pyprojectToolSectionsChanged(before, afterDepOnly), false);
  assert.equal(pyprojectToolSectionsChanged(before, afterToolChanged), true);
  assert.equal(pyprojectToolSectionsChanged(null, before), true);
  assert.equal(pyprojectToolSectionsChanged(before, before), false);
});

test('REQ-GATE-44 testShape finds tests after a regex literal with an odd number of backticks', () => {
  const shape = testShape(
    [
      "import { test } from 'node:test';",
      'const PATH = /`((?:\\.claude|docs)\\/[^`\\s<>*]+\\.(?:md|mjs|js|json))`/g;',
      'const Q = (s) => s.match(/"[^/]*/);',
      "test('finds paths', () => { assert.equal(PATH.exec('x'), false); });",
      "test('finds more', () => { assert.ok(Q('a')); });",
    ].join('\n'),
  );
  assert.deepEqual(shape.tests, ['finds paths', 'finds more']);
  assert.equal(shape.assertions, 2);
});

test('REQ-GATE-44 testShape treats a/b/c as division', () => {
  const shape = testShape(
    [
      'const x = a / b / c; const s = a / b; const u = `/`;',
      "const y = f(1) / 2 + arr[0] / 3; const q = '`';",
      "test('after division', () => { assert.equal(x, y); });",
      'const z = 4 / n; // a ` in a comment',
      "test('still found', () => { assert.ok(z); });",
    ].join('\n'),
  );
  assert.deepEqual(shape.tests, ['after division', 'still found']);
  assert.equal(shape.assertions, 2);
});

test('REQ-GATE-44 testShape blanks a regex literal after return and at a line start, not a lone slash', () => {
  const shape = testShape(
    [
      'function r() { return /`/; }',
      "  /\"/.exec('a');",
      'const half = n /',
      "  2; test('after lone slash', () => { assert.ok(half); });",
      "test('class slash', () => { assert.ok(/[/'`]/.exec(r())); });",
      "const t = /test\\('fake'\\)/;",
      "def f(a, /, b): test('no closing slash', () => { assert.ok(a); });",
    ].join('\n'),
  );
  assert.deepEqual(shape.tests, ['after lone slash', 'class slash', 'no closing slash']);
  assert.equal(shape.assertions, 3);
});

test('REQ-GATE-44 testShape reads /> after a JSX prop expression as a tag end, not a regex', () => {
  const shape = testShape(
    [
      "test('renders', () => { render(<A b={c} />); expect(x).toBe('a/b'); });",
      "test('spreads', () => { render(<A {...p}/>); assert.equal(y, 'c/d'); });",
    ].join('\n'),
  );
  assert.deepEqual(shape.tests, ['renders', 'spreads']);
  assert.equal(shape.assertions, 2);
});

test('REQ-GATE-44 testShape reads /> at a line start as a JSX tag end, not a regex', () => {
  const shape = testShape(["test('multi-line', () => {", '  render(<A', '    b={c}', "  />); expect(x).toBe('a/b');", '});'].join('\n'));
  assert.deepEqual(shape.tests, ['multi-line']);
  assert.equal(shape.assertions, 1);
});
