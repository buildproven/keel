import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { loadConfig, readCard } from '../src/config.js';
import { formatReport, readLedger, report } from '../src/ledger.js';
import { APPROVAL_LINE, awaitsApproval, pickIssue } from '../src/linear.js';
import { poll, pollExitCode } from '../src/poll.js';
import {
  cardFile,
  fileProposals,
  parseProposals,
  proposeCards,
  proposedDir,
  proposedTitles,
  proposePrompt,
  proposeTierOf,
  repoSignals,
  writeProposals,
} from '../src/propose.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp, write } from './helpers.js';

const FAKE = new URL('./fake-worker.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-propose-state-');
});

const card = (title, { kind = 'bug', size = 'S', extra = '' } = {}) => `TITLE: ${title}
The add helper subtracts; callers get wrong totals.

## Requirements

- REQ-ADD-1: When add is called with 2 and 3, the add helper shall return 5.

## Acceptance

- [ ] a test calls add(2, 3) and gets 5

\`\`\`keel
kind: ${kind}
size: ${size}
paths: src/add.js, test/add-sum.test.js${extra}
\`\`\``;

test('REQ-PROPOSE-1 signals come from the base commit: markers outside tests, and source files no test path names', () => {
  const { dir } = fixtureRepo();
  const base = commit(dir, {
    'src/util.js': '// TODO: handle negative numbers\nexport const neg = (n) => -n;\n',
    'src/basic.js': 'export const basic = 1;\n',
    'test/util-extra.test.js': '// TODO a test marker is not a signal\n',
    'README.md': 'FIXME: document install\n',
  });
  write(dir, { 'src/later.js': '// FIXME: not committed\n' }); // the working tree is not read
  const s = repoSignals(dir, base, fixtureConfig());
  assert.deepEqual(s.markers, ['README.md:1:FIXME: document install', 'src/util.js:1:// TODO: handle negative numbers']);
  assert.equal(s.markerCount, 2);
  assert.deepEqual(s.untested, ['src/add.js'], 'basic and util are named by test paths; add is not');
  assert.equal(s.tests, 2);
});

test('REQ-PROPOSE-2 the prompt is read-only, carries the signals, the queued work, the count, and the focus', () => {
  const signals = {
    files: 9,
    sources: 3,
    tests: 2,
    markers: ['a.js:1:// TODO x'],
    markerCount: 1,
    untested: ['src/b.js'],
    untestedCount: 1,
  };
  const p = proposePrompt({ signals, keelJson: '{"checks":{}}', open: ['Fix the totals'], max: 2, focus: 'more tests' });
  assert.match(p, /at most 2 cards/);
  assert.match(p, /this turn is read-only/);
  assert.match(p, /^PROPOSALS|`PROPOSALS`/m);
  assert.match(p, /- a\.js:1:\/\/ TODO x/);
  assert.match(p, /- src\/b\.js/);
  assert.match(p, /# Work already queued[^\n]*\n- Fix the totals/);
  assert.match(p, /focus on: more tests/);
  assert.match(p, /Omit `allowEdits`/);
});

test('REQ-PROPOSE-3 a reply is parsed strictly: NONE, a bad first line, and cards kept or dropped with a reason', () => {
  assert.deepEqual(parseProposals('NONE the backlog covers it\n{"is_error":false}', { max: 3 }), {
    kind: 'none',
    why: 'the backlog covers it',
  });
  assert.equal(parseProposals('Here are my ideas', { max: 3 }).kind, 'unparsed');
  assert.equal(parseProposals('PROPOSALS\nno cards here', { max: 3 }).kind, 'unparsed');
  const reply = [
    'PROPOSALS',
    card('Fix add to sum'),
    card('Fix the totals'), // queued already
    card('Unlock a test', { extra: '\nallowEdits: test/basic.test.js' }),
    card('Rewrite everything', { size: 'L' }),
    card('fix ADD to sum'), // same title as the first
    card('Add a sum test', { kind: 'chore' }),
    card('One too many'),
  ].join('\n\n');
  const r = parseProposals(reply, { max: 2, open: ['Fix the totals'] });
  assert.equal(r.kind, 'proposals');
  assert.deepEqual(
    r.cards.map((c) => c.title),
    ['Fix add to sum', 'Add a sum test'],
  );
  assert.match(r.cards[0].body, /^The add helper subtracts/);
  const why = Object.fromEntries(r.dropped.map((d) => [d.title, d.why]));
  assert.match(why['Fix the totals'], /repeats queued work/);
  assert.match(why['Unlock a test'], /allowEdits test\/basic\.test\.js/);
  assert.match(why['Rewrite everything'], /size L is not S or M/);
  assert.match(why['fix ADD to sum'], /earlier proposal/);
  assert.match(why['One too many'], /past the 2 cards/);
});

/** A fake-worker tier that answers `answer` and logs its calls. */
function sayTier(answer, model = 'strong') {
  const script = join(tmp('keel-propose-script-'), 'script.json');
  writeFileSync(script, JSON.stringify([`say:${answer}`]));
  return { provider: 'exec', model, effort: 'high', command: ['node', FAKE, 'script', script] };
}

test('REQ-PROPOSE-4 one turn runs on the strongest tier by default, is recorded as a propose row, and is spend, not a run', () => {
  const { dir } = fixtureRepo();
  const log = join(tmp('keel-propose-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = log;
  const cheap = { provider: 'exec', model: 'cheap', effort: 'high', command: ['node', FAKE, 'crash'] };
  const config = fixtureConfig({ tiers: [cheap, sayTier(`PROPOSALS\n${card('Fix add to sum')}`)] });
  assert.equal(proposeTierOf(config), 1);
  assert.equal(proposeTierOf({ ...config, proposeTier: 0 }), 0);
  const r = proposeCards({ repo: dir, base: 'HEAD', config, open: ['Something queued'] });
  delete process.env.KEEL_FAKE_LOG;
  assert.equal(r.tier, 1);
  assert.equal(r.parsed.kind, 'proposals');
  const [call] = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(call.prompt, /- Something queued/);
  assert.equal(g(dir, 'status', '--porcelain'), '', 'the repo is untouched');
  const rows = readLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'propose');
  assert.equal(rows[0].outcome, 'proposals');
  assert.equal(rows[0].proposed, 1);
  const rep = report(rows);
  assert.equal(rep.total, 0, 'a propose turn is not a run');
  assert.match(formatReport(rep), /propose turns: 1, 1 cards drafted; cost \$0\.01/);
});

test('REQ-PROPOSE-4 a reserved provider moves the turn to a usable tier, and none usable is quota', () => {
  const { dir } = fixtureRepo();
  const t = sayTier('NONE fine as is');
  const config = fixtureConfig({ tiers: [t, { ...t, provider: 'exec' }] });
  const none = proposeCards({ repo: dir, base: 'HEAD', config, reserved: new Map([['exec', '5-hour 95 %']]) });
  assert.equal(none.status, 'quota');
  assert.equal(readLedger().length, 0);
});

test('REQ-PROPOSE-5 proposals become card files outside the repo, numbered on, that keel run reads', () => {
  const { dir } = fixtureRepo();
  const { cards } = parseProposals(`PROPOSALS\n${card('Fix add to sum')}\n\n${card('Add a sum test', { kind: 'chore' })}`, { max: 3 });
  const paths = writeProposals(dir, cards);
  assert.deepEqual(paths, [join(proposedDir(dir), 'PROP-1.md'), join(proposedDir(dir), 'PROP-2.md')]);
  assert.ok(!paths[0].startsWith(dir), 'outside the repo');
  const c = readCard(paths[0]);
  assert.equal(c.id, 'PROP-1');
  assert.equal(c.kind, 'bug');
  assert.equal(c.size, 'S');
  assert.deepEqual(c.paths, ['src/add.js', 'test/add-sum.test.js']);
  assert.match(c.text, /## Context\n\nThe add helper subtracts/);
  assert.match(c.text, /## Requirements\n\n- REQ-ADD-1/);
  assert.doesNotMatch(c.text, /```keel/);
  const more = writeProposals(dir, [{ ...cards[0], title: 'Third one' }]);
  assert.deepEqual(more, [join(proposedDir(dir), 'PROP-3.md')]);
  assert.deepEqual(proposedTitles(dir), ['Fix add to sum', 'Add a sum test', 'Third one']);
  // A context line that looks like a header stays text: it sits under ## Context.
  const text = cardFile('PROP-9', { title: 'T', body: `Why: totals are wrong\n\n${card('x').split('\n').slice(2).join('\n')}` });
  assert.match(text, /## Context\n\nWhy: totals are wrong/);
});

function linearFake(issues = []) {
  const created = [];
  return {
    created,
    listIssues: async () => issues,
    comment: async () => {},
    review: async () => {},
    stateType: async () => 'started',
    createIssue: async (sourceId, fields, project) => {
      created.push({ sourceId, fields, project });
      return `BUI-${100 + created.length}`;
    },
  };
}

test('REQ-PROPOSE-6 filed proposals are Low issues that wait for approval; deleting the line approves them', async () => {
  const { cards } = parseProposals(`PROPOSALS\n${card('Fix add to sum')}`, { max: 3 });
  const client = linearFake();
  const ids = await fileProposals({ client, project: 'web', config: fixtureConfig(), cards });
  assert.deepEqual(ids, ['BUI-101']);
  const [{ sourceId, fields, project }] = client.created;
  assert.equal(sourceId, null);
  assert.equal(project, 'web');
  assert.equal(fields.priority, 4);
  assert.equal(fields.description.split('\n')[0], APPROVAL_LINE);
  const issue = { id: 'BUI-101', title: fields.title, description: fields.description, priority: 4, createdAt: '2026-10-01', labels: [] };
  assert.ok(awaitsApproval(issue));
  assert.equal(pickIssue([issue], new Set()), null, 'never picked while it waits');
  const approved = { ...issue, description: fields.description.replace(`${APPROVAL_LINE}\n`, '') };
  assert.equal(pickIssue([approved], new Set())?.id, 'BUI-101');
  const auto = linearFake();
  await fileProposals({ client: auto, project: 'web', config: fixtureConfig({ proposeApproval: false }), cards });
  assert.ok(!auto.created[0].fields.description.includes(APPROVAL_LINE));
});

const noBuild = () => assert.fail('nothing is built');
const proposing =
  (parsed, calls = []) =>
  (args) => {
    calls.push(args);
    return { status: 'ok', output: '', parsed, tier: 0 };
  };

test('REQ-PROPOSE-7 poll --propose files cards once nothing is eligible; without --propose it proposes nothing', async () => {
  const { dir } = fixtureRepo();
  const parsed = parseProposals(`PROPOSALS\n${card('Fix add to sum')}`, { max: 3 });
  const calls = [];
  const client = linearFake([]);
  const base = { repo: dir, project: 'web', client, config: fixtureConfig({ linearProject: 'web' }), runFn: noBuild, capacityFn: null };
  assert.deepEqual(await poll({ ...base, proposeFn: proposing(parsed, calls) }), [{ outcome: 'none' }]);
  assert.equal(calls.length, 0);
  const r = await poll({ ...base, proposeFn: proposing(parsed, calls), propose: true });
  assert.equal(r.at(-1).outcome, 'proposed');
  assert.equal(r.at(-1).issue, 'BUI-101');
  assert.equal(pollExitCode(r), 0);
  assert.equal(client.created.length, 1);
});

test('REQ-PROPOSE-7 a proposal still waiting, or a full workspace, holds the next turn; an unparsed answer fails the pass', async () => {
  const { dir } = fixtureRepo();
  const calls = [];
  const waiting = { id: 'BUI-5', title: 'x', description: `${APPROVAL_LINE}\n\nbody`, priority: 4, createdAt: '2026-10-01', labels: [] };
  const config = fixtureConfig({ linearProject: 'web' });
  const run = (client, extra) =>
    poll({ repo: dir, project: 'web', client, config, runFn: noBuild, capacityFn: null, propose: true, ...extra });
  const held = await run(linearFake([waiting]), { proposeFn: proposing({ kind: 'none', why: 'x' }, calls) });
  assert.deepEqual(held.at(-1), { outcome: 'none', detail: { waiting: ['BUI-5'] } });
  const full = await run(linearFake([]), {
    proposeFn: proposing({ kind: 'none', why: 'x' }, calls),
    capacityFn: async () => ({ open: 200 }),
  });
  assert.deepEqual(full.at(-1), { outcome: 'none', detail: { held: 200 } });
  assert.equal(calls.length, 0, 'no turn was paid for');
  const bad = await run(linearFake([]), { proposeFn: proposing({ kind: 'unparsed', why: 'no keyword' }) });
  assert.equal(bad.at(-1).outcome, 'proposeFailed');
  assert.equal(pollExitCode(bad), 1);
});

test('REQ-PROPOSE-8 keel.json validates proposeMax, proposeApproval, proposeTier, and sourceGlobs', () => {
  const { dir } = fixtureRepo();
  const at = (over) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', ...over }) });
    return () => loadConfig(dir, 'HEAD');
  };
  const defaults = at({})();
  assert.equal(defaults.proposeMax, 3);
  assert.equal(defaults.proposeApproval, true);
  assert.throws(at({ proposeMax: 0 }), /"proposeMax" must be an integer from 1 to 10/);
  assert.throws(at({ proposeMax: 11 }), /"proposeMax"/);
  assert.throws(at({ proposeApproval: 'yes' }), /"proposeApproval" must be true or false/);
  assert.throws(at({ proposeTier: 9 }), /"proposeTier" must be null or a tier index/);
  assert.throws(at({ sourceGlobs: '**/*.js' }), /"sourceGlobs" must be an array of strings/);
});
