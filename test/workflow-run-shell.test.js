import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowWeakened } from '../src/workflow.js';

// A base job whose only run step is `run`, given as YAML block lines; the head appends one plain run step.
const workflow = (run) => `name: quality
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
${run
  .split('\n')
  .map((l) => (l ? `          ${l}` : ''))
  .join('\n')}
`;
const ADDED = '      - run: npm run audit\n';
const weakened = (run) => workflowWeakened(workflow(run), `${workflow(run)}${ADDED}`, ['npm test']);
const NONE = /runs no configured check or test command/;

test('REQ-GATE-43 a configured command inside a heredoc body, a quoted string, or a continued line does not count as run', () => {
  for (const run of [
    'cat <<EOF > notes.txt\nnpm test\nEOF',
    "cat <<'EOF'\nnpm test\nEOF",
    'cat << "END"\nnpm test\nEND',
    'cat <<-EOF\nnpm test\nEOF',
    'cat <<E"O"F\nnpm test\nEOF',
    'cat <<A <<B\nfirst\nA\nnpm test\nB',
    'cat <<EOF\n  EOF\nnpm test',
    "echo 'first\nnpm test'",
    'echo "first\nnpm test"',
    'echo "say \\"hi\nnpm test"',
    "echo $'it\\'s\nnpm test'",
    'echo \\\nnpm test',
    'echo \'a\' "b\nnpm test"',
    "cat <<EOF; echo 'x\nnpm test\nEOF",
    'echo $((1<<2))\nnpm test',
  ])
    assert.match(weakened(run) ?? '', NONE, run);
});

test('REQ-GATE-43 a configured command on its own shell line still counts after a heredoc, a closed quote, or a comment', () => {
  for (const run of [
    'npm test',
    'npm ci\nnpm test',
    'cat <<EOF > notes.txt\nhello\nEOF\nnpm test',
    'cat <<-EOF\nhello\nEOF\nnpm test',
    "echo 'first\nsecond'\nnpm test",
    'echo "first\nsecond"\nnpm test',
    "# don't skip the tests\nnpm test",
    "echo ok # it's fine\nnpm test",
    'cat <<< "x"\nnpm test',
    'echo "<<EOF"\nnpm test',
    "echo '<<EOF'\nnpm test",
    'echo a\\\\\nnpm test',
    'npm ci \\\n  --silent\nnpm test --coverage',
  ])
    assert.equal(weakened(run), null, run);
});

test('REQ-GATE-43 a folded run block is still read as one command line', () => {
  const fold = (run) => workflow(run).replace('- run: |', '- run: >');
  const head = (run) => `${fold(run)}${ADDED}`;
  assert.equal(workflowWeakened(fold('npm test\n--coverage'), head('npm test\n--coverage'), ['npm test']), null);
  assert.match(workflowWeakened(fold("echo 'x\nnpm test'"), head("echo 'x\nnpm test'"), ['npm test']) ?? '', NONE);
});
