import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBypassMarkers } from '../src/scan.js';

const lines = (...texts) => texts.map((text, i) => ({ path: 'f', line: i + 1, text }));

test('REQ-GATE-8 finds inline lint config and file-level suppression pragmas', () => {
  const marked = [
    '/* eslint no-unused-vars: "off" */',
    '/* eslint @typescript-eslint/no-explicit-any: 0 */',
    '# ruff: noqa',
    '# ruff: noqa: E501',
    'x = f()  # pyright: ignore[reportGeneralTypeIssues]',
    '# pyright: basic',
    '# mypy: ignore-errors',
    '# mypy: disable-error-code="arg-type"',
    '# pylint: disable=unused-import',
    '// biome-ignore lint/suspicious/noExplicitAny: reason',
    '// prettier-ignore',
    '// deno-lint-ignore no-explicit-any',
    '// oxlint-disable-next-line no-console',
  ];
  assert.deepEqual(
    findBypassMarkers(lines(...marked)).map((f) => f.text),
    marked,
  );
});

test('REQ-GATE-8 ordinary comments that name a tool are not bypass markers', () => {
  const clean = ['/* eslint-env node */', '// configure eslint in eslint.config.js', '# ruff is the linter', '# see mypy docs'];
  assert.deepEqual(findBypassMarkers(lines(...clean)), []);
});
