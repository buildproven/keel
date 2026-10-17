// REQ-TRACE-1/2: the V-model traceability links are checked by machine, not by memory.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const design = read('docs/DESIGN.md');

const requirementIds = [...design.matchAll(/^- \*\*(REQ-[A-Z]+-\d+)\*\*/gm)].map((m) => m[1]);

// A test title is the first string literal after `test(` — on the same line or the next (prettier wraps).
const testFiles = readdirSync(new URL('../test', import.meta.url)).filter((f) => f.endsWith('.test.js'));
const titles = testFiles.flatMap((f) =>
  [...read(`test/${f}`).matchAll(/^\s*test\(\s*(['"`])(.*?)\1/gms)].map((m) => ({ file: f, title: m[2] })),
);
const idOf = (title) => title.match(/^(REQ-[A-Z]+-\d+)\b/)?.[1];

test('REQ-TRACE-1 every requirement in DESIGN §5 has a test whose title starts with its ID', () => {
  assert.ok(requirementIds.length > 50, `parsed only ${requirementIds.length} requirement IDs`);
  assert.equal(new Set(requirementIds).size, requirementIds.length, 'duplicate requirement ID in DESIGN §5');
  const proven = new Set(titles.map((t) => idOf(t.title)));
  const missing = requirementIds.filter((id) => !proven.has(id));
  assert.deepEqual(missing, [], `requirements with no test: ${missing.join(', ')}`);
});

test('REQ-TRACE-1 every test title starts with an ID that exists in DESIGN §5', () => {
  const known = new Set(requirementIds);
  const bad = titles.filter((t) => !known.has(idOf(t.title)));
  assert.deepEqual(
    bad.map((t) => `${t.file}: ${t.title}`),
    [],
    'tests with no or an unknown requirement ID',
  );
});

test('REQ-TRACE-2 the DESIGN module table lists exactly the files in src/ and bin/', () => {
  const documented = [...design.matchAll(/^\| `((?:src|bin)\/[\w.-]+\.js)`/gm)].map((m) => m[1]).sort();
  const actual = [
    ...readdirSync(new URL('../src', import.meta.url)).map((f) => `src/${f}`),
    ...readdirSync(new URL('../bin', import.meta.url)).map((f) => `bin/${f}`),
  ].sort();
  assert.deepEqual(documented, actual);
});

test('REQ-TRACE-3 the documentation set stays small: only listed files', () => {
  const docs = readdirSync(new URL('../docs', import.meta.url)).filter((f) => f.endsWith('.md'));
  assert.deepEqual(docs.sort(), ['DESIGN.md', 'PILOT.md', 'UNATTENDED.md']);
});
