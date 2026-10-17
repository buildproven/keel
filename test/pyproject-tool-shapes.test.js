import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pyprojectToolSectionsChanged } from '../src/scan.js';

const BASE = '[project]\nname = "x"\ndependencies = []\n';
const changed = (head) => pyprojectToolSectionsChanged(BASE, head);

test('REQ-PROJ-4 a locked tool table with spaces or quoted keys in its header is locked', () => {
  assert.equal(changed(`${BASE}\n[ tool.pytest.ini_options ]\naddopts = "--collect-only"\n`), true);
  assert.equal(changed(`${BASE}\n[tool."pytest".ini_options]\naddopts = "--collect-only"\n`), true);
  assert.equal(changed(`${BASE}\n[ tool . 'ruff' ]\nexclude = ["*"]\n`), true);
});

test('REQ-PROJ-4 dotted keys that reach a tool table are locked: under a bare [tool] table and at the root', () => {
  assert.equal(changed(`${BASE}\n[tool]\npytest.ini_options.addopts = "--collect-only"\n`), true);
  assert.equal(changed(`tool.pytest.ini_options.addopts = "--collect-only"\n${BASE}`), true);
  assert.equal(changed(`"tool".mypy.ignore_errors = true\n${BASE}`), true);
});

test('REQ-PROJ-4 other pyproject tables stay free to change', () => {
  assert.equal(changed('[project]\nname = "x"\ndependencies = ["requests"]\n'), false);
  assert.equal(changed(`${BASE}\n[ tool.black ]\nline-length = 100\n`), false);
  assert.equal(changed(`${BASE}\n[build-system]\nrequires = ["hatchling"]\n`), false);
});

test('REQ-PROJ-4 quoted keys are decoded as TOML decodes them, so an escaped tool name is still locked', () => {
  assert.equal(changed(`${BASE}\n[tool."py\\u0074est".ini_options]\naddopts = "--collect-only"\n`), true);
  assert.equal(changed(`${BASE}\n[tool."py\\U00000074est"]\naddopts = "x"\n`), true);
});

test('REQ-PROJ-4 a header-like line inside a multi-line string is not a table header', () => {
  const head = `x = """\n[project]\n"""\ntool.pytest.ini_options.addopts = "--collect-only"\n${BASE}`;
  assert.equal(changed(head), true);
  const literal = `x = '''\n[project]\n'''\ntool.ruff.exclude = ["*"]\n${BASE}`;
  assert.equal(changed(literal), true);
});

test('REQ-PROJ-4 every line of a multi-line value under a locked key is locked', () => {
  const before = `tool.ruff.exclude = [\n  "a",\n]\n${BASE}`;
  const after = `tool.ruff.exclude = [\n  "*",\n]\n${BASE}`;
  assert.equal(pyprojectToolSectionsChanged(before, after), true);
  const inTable = (v) => `${BASE}\n[tool.pytest.ini_options]\naddopts = """\n${v}\n"""\n`;
  assert.equal(pyprojectToolSectionsChanged(inTable('-q'), inTable('--collect-only')), true);
});

test('REQ-PROJ-4 a header or key it cannot read is locked (fail closed)', () => {
  assert.equal(changed(`${BASE}\n[tool."bad\\q"]\naddopts = "x"\n`), true);
  assert.equal(changed(`${BASE}\n[tool.pytest\naddopts = "x"\n`), true);
});

test('REQ-PROJ-4 a multi-line string in a free table does not hide what follows it', () => {
  const head = `[project]\nname = "x"\ndescription = """\n[tool.black]\n"""\n\n[tool.pytest.ini_options]\naddopts = "--collect-only"\n`;
  assert.equal(pyprojectToolSectionsChanged('[project]\nname = "x"\n', head), true);
  assert.equal(
    pyprojectToolSectionsChanged('[project]\nname = "x"\n', '[project]\nname = "x"\ndescription = """\n[tool.pytest]\n"""\n'),
    false,
  );
});
