import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowWeakened } from '../src/workflow.js';

const workflow = (run) => `name: quality
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
${run
  .split('\n')
  .map((line) => `          ${line}`)
  .join('\n')}
`;
const ADDED = '      - run: npm run audit\n';
const weakened = (run) => workflowWeakened(workflow(run), `${workflow(run)}${ADDED}`, ['npm test']);
const NO_COMMAND = /runs no configured check or test command/;

test('REQ-GATE-43 an escaped shell separator before # does not turn the heredoc operator into a comment', () => {
  for (const run of [
    'cat a\\ #<<EOF\nnpm test\nEOF',
    'cat a\\;#<<EOF\nnpm test\nEOF',
    'cat a\\|#<<EOF\nnpm test\nEOF',
    'cat a\\(#<<EOF\nnpm test\nEOF',
    'cat a\\&#<<EOF\nnpm test\nEOF',
    'cat a\\)#<<EOF\nnpm test\nEOF',
    'cat a\\<#<<EOF\nnpm test\nEOF',
    'cat a\\>#<<EOF\nnpm test\nEOF',
    'cat a\\\t#<<EOF\nnpm test\nEOF',
    'cat a\\##<<EOF\nnpm test\nEOF',
    'cat a\\\n#<<EOF\nnpm test\nEOF',
  ])
    assert.match(weakened(run) ?? '', NO_COMMAND, run);
});

test('REQ-GATE-43 an unescaped separator still lets # start a shell comment', () => {
  for (const run of ['cat a #<<EOF\nnpm test\nEOF', 'cat a;#<<EOF\nnpm test\nEOF', 'cat a\\\\ #<<EOF\nnpm test\nEOF'])
    assert.equal(weakened(run), null, run);
});
