import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { setupAdvice } from '../src/doctor.js';
import { claudeWindows, codexWindows, planLine, readPlan, reservedProviders } from '../src/plan.js';
import { poll, pollExitCode } from '../src/poll.js';
import { run, skipReserved } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-plan-');
});

const NOW = 1792490000; // epoch seconds
const claudeStream = [
  '{"type":"system","subtype":"init","session_id":"s"}',
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.04,"resetsAt":${NOW + 3600}},"seven_day":{"utilization":0.34,"resetsAt":${NOW + 86400}}}}}`,
  '{"type":"result","result":"ok","total_cost_usd":0.004}',
].join('\n');
const codexLine = (five, week, resets = NOW + 3600) =>
  `{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":${five},"window_minutes":300,"resets_at":${resets}},"secondary":{"used_percent":${week},"window_minutes":10080,"resets_at":${NOW + 86400}}}}}`;

test('REQ-PLAN-1 the Claude probe output gives the 5-hour and weekly plan windows in percent', () => {
  assert.deepEqual(claudeWindows(claudeStream, NOW), {
    fiveHour: { used: 4, resetsAt: NOW + 3600 },
    week: { used: 34, resetsAt: NOW + 86400 },
  });
  assert.equal(claudeWindows('{"type":"result","result":"ok"}', NOW), null, 'no rate_limit_event (API key): unknown');
});

test('REQ-PLAN-1 the newest Codex rate_limits line gives its windows; a window past its reset reads 0', () => {
  const text = [codexLine(10, 2), '{"type":"other"}', codexLine(41, 6)].join('\n');
  assert.deepEqual(codexWindows(text, NOW), {
    fiveHour: { used: 41, resetsAt: NOW + 3600 },
    week: { used: 6, resetsAt: NOW + 86400 },
  });
  assert.equal(codexWindows(codexLine(95, 6, NOW - 1), NOW).fiveHour.used, 0, 'the 5-hour window has reset since');
  assert.equal(codexWindows('{"type":"x"}', NOW), null);
});

test('REQ-PLAN-1 readPlan reads Codex windows from the newest session file under CODEX_HOME', () => {
  const home = tmp('codex-home-');
  const day = join(home, 'sessions', '2026', '10', '20');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-old.jsonl'), `${codexLine(99, 99)}\n`);
  utimesSync(join(day, 'rollout-old.jsonl'), NOW - 7200, NOW - 7200);
  writeFileSync(join(day, 'rollout-new.jsonl'), `${codexLine(41, 6)}\n`);
  const config = {
    tiers: [
      { provider: 'claude', model: 'm' },
      { provider: 'codex', model: 'c' },
    ],
  };
  const plan = readPlan(config, { now: NOW, codexHome: home, claudeProbe: () => claudeStream });
  assert.equal(plan.codex.fiveHour.used, 41);
  assert.equal(plan.claude.week.used, 34);
  assert.equal(readPlan(config, { now: NOW, codexHome: tmp('empty-'), claudeProbe: () => '' }).codex, null);
});

test('REQ-PLAN-2 a provider at or over a planLimits window is reserved, with the reason; unknown windows are not', () => {
  const plan = {
    claude: { fiveHour: { used: 4, resetsAt: NOW }, week: { used: 81, resetsAt: NOW } },
    codex: { fiveHour: { used: 90, resetsAt: NOW }, week: { used: 6, resetsAt: NOW } },
    exec: null,
  };
  const reserved = reservedProviders(plan, { fiveHour: 90, week: 80 });
  assert.deepEqual([...reserved.keys()].sort(), ['claude', 'codex']);
  assert.match(reserved.get('claude'), /week 81% ≥ 80%/);
  assert.match(reserved.get('codex'), /5h 90% ≥ 90%/);
  assert.match(planLine(plan), /claude 5h 4% · week 81%.*codex 5h 90% · week 6%/);
});

test('REQ-PLAN-2 planLimits defaults to 5-hour 90 % and week 80 %, accepts null, and rejects a bad value', () => {
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', ...extra }) });
    return loadConfig(dir, 'HEAD');
  };
  assert.deepEqual(at({}).planLimits, { fiveHour: 90, week: 80 });
  assert.equal(at({ planLimits: null }).planLimits, null);
  assert.throws(() => at({ planLimits: { fiveHour: 0, week: 80 } }), /planLimits/);
  assert.throws(() => at({ planLimits: { fiveHour: 90 } }), /planLimits/);
});

test('REQ-PLAN-3 skipReserved moves past a reserved provider to another provider at or above the floor, or gives null', () => {
  const tiers = [{ provider: 'claude' }, { provider: 'claude' }, { provider: 'codex' }];
  assert.equal(skipReserved(tiers, 0, 0, new Map([['claude', 'week']])), 2);
  assert.equal(skipReserved(tiers, 0, 0, new Map([['codex', 'week']])), 0);
  assert.equal(skipReserved(tiers, 2, 0, new Map([['codex', 'week']])), null);
  assert.equal(
    skipReserved(
      tiers,
      0,
      0,
      new Map([
        ['claude', 'w'],
        ['codex', 'w'],
      ]),
    ),
    null,
  );
});

test('REQ-PLAN-3 keel run with every tier reserved stops as quota without calling a worker', () => {
  const { dir } = fixtureRepo();
  const log = [];
  const config = fixtureConfig({ tiers: [{ provider: 'exec', command: ['false'], model: 'm', effort: 'e' }] });
  const card = { id: 'PLAN-1', kind: 'chore', size: 'S', paths: [], allowEdits: [], text: '# c' };
  const r = run({ repo: dir, card, config, reserved: new Map([['exec', 'week 81% ≥ 80%']]), log: (m) => log.push(m) });
  assert.equal(r.stopped, 'quota');
  assert.ok(
    log.some((l) => /tier 0 skipped: exec plan window week 81% ≥ 80%/.test(l)),
    log.join('\n'),
  );
  assert.ok(!log.some((l) => /^attempt 1/.test(l)));
});

const issue = { id: 'BUI-9', title: 't', description: '- REQ-1: it shall work.', priority: 2, createdAt: '2026-09-01', labels: ['Bug'] };
const client = { listIssues: async () => [issue], comment: async () => {}, review: async () => {}, stateType: async () => 'started' };
const tiers = [{ provider: 'claude' }, { provider: 'codex' }];

test('REQ-PLAN-3 keel poll stops with outcome plan, exit 3, when every provider of the ladder is reserved', async () => {
  const { dir } = fixtureRepo();
  const log = [];
  let ran = 0;
  const planFn = () => ({
    claude: { fiveHour: { used: 95, resetsAt: NOW } },
    codex: { week: { used: 85, resetsAt: NOW } },
  });
  const results = await poll({
    repo: dir,
    project: 'x',
    client,
    config: { planLimits: { fiveHour: 90, week: 80 }, tiers },
    runFn: () => (ran++, { pass: true }),
    planFn,
    log: (m) => log.push(m),
  });
  assert.equal(ran, 0);
  assert.equal(results.at(-1).outcome, 'plan');
  assert.equal(pollExitCode(results), 3);
  assert.ok(
    log.some((l) => /plan limit reached: claude 5h 95% ≥ 90%; codex week 85% ≥ 80%/.test(l)),
    log.join('\n'),
  );
});

test('REQ-PLAN-3 keel poll passes the reserved providers to the run and logs the plan line when only some are reserved', async () => {
  const { dir } = fixtureRepo();
  const log = [];
  let seen;
  const planFn = () => ({ claude: { week: { used: 85, resetsAt: NOW } }, codex: { week: { used: 6, resetsAt: NOW } } });
  await poll({
    repo: dir,
    project: 'x',
    client,
    config: { planLimits: { fiveHour: 90, week: 80 }, tiers },
    runFn: (o) => ((seen = o.reserved), { pass: false, stopped: 'blocked', failure: 'x' }),
    planFn,
    log: (m) => log.push(m),
  });
  assert.deepEqual([...seen.keys()], ['claude']);
  assert.ok(
    log.some((l) => /^plan: claude week 85%; codex week 6%/.test(l)),
    log.join('\n'),
  );
});

test('REQ-PLAN-4 doctor advice says dailyBudgetUsd is a list-price estimate when a tier is a Claude or Codex subscription', () => {
  const tiersSub = [{ provider: 'claude', model: 'm', effort: 'e' }];
  const advice = setupAdvice(fixtureConfig({ testFilesCommand: 'x {files}', dailyBudgetUsd: 5, tiers: tiersSub }));
  assert.equal(advice.length, 1);
  assert.match(advice[0], /^dailyBudgetUsd 5 counts list-price estimates.*planLimits \(5h 90%, week 80%\)/);
  assert.deepEqual(
    setupAdvice(fixtureConfig({ testFilesCommand: 'x {files}', dailyBudgetUsd: 5, tiers: [{ provider: 'exec', command: ['x'] }] })),
    [],
  );
  assert.deepEqual(setupAdvice(fixtureConfig({ testFilesCommand: 'x {files}', tiers: tiersSub })), []);
});
