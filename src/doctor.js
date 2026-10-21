import { prepareCheckout, shell } from './gate.js';
import { exec, revParse, withTempWorktree } from './git.js';
import { duplicateWork, fmtMs, serialReason } from './timing.js';

const tail = (s, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s);

/**
 * Run a repo's configured commands on a fresh checkout of base, prepared exactly as the gate prepares one
 * (REQ-CLI-3, REQ-GATE-16). Rows: { name, kind: install|check|test|acceptance, pass, output }. A check that
 * is red or unrunnable here makes every card fail at every tier, so find out before running one.
 */
export function doctor({ repo, base, config, slowSuiteMs = SLOW_SUITE_MS }) {
  const sha = revParse(base, repo);
  return withTempWorktree(repo, sha, (dir) => {
    const installed = prepareCheckout(repo, dir, config);
    if (installed) return [{ name: 'install', kind: 'install', pass: false, output: tail(installed.out) }];
    const rows = config.install ? [{ name: 'install', kind: 'install', pass: true, output: '' }] : [];
    const run = (name, kind, command) => {
      const start = Date.now();
      const r = shell(command, dir, config);
      rows.push({ name, kind, pass: r.code === 0, output: tail(r.out), ms: Date.now() - start });
    };
    for (const [name, command] of Object.entries(config.checks)) run(name, 'check', command);
    const testInChecks = Object.values(config.checks).includes(config.testCommand);
    if (!testInChecks) run('test', 'test', config.testCommand);
    for (const [name, command] of Object.entries(config.acceptance)) run(name, 'acceptance', command);
    return [...rows, ...advice(rows, config, dir, testInChecks, slowSuiteMs)];
  });
}

/** A test run longer than this is a large suite, where one core is a real cost (REQ-CLI-13). */
export const SLOW_SUITE_MS = 60_000;

/**
 * Speed advice from what the doctor just ran (REQ-CLI-13): a slow test command that runs on one worker, and
 * commands two checks both run. Rows of kind `advice`; they never fail the doctor.
 */
function advice(rows, config, dir, testInChecks, slowSuiteMs) {
  const out = [];
  const testRow = rows.find(
    (r) => r.name === 'test' || Object.entries(config.checks).some(([n, c]) => n === r.name && c === config.testCommand),
  );
  // Judged by the measured time, so a wrapper script cannot hide a slow suite; the command's shape only names the fix (REQ-CLI-14).
  if (testRow?.ms > slowSuiteMs) {
    const serial = serialReason(config.testCommand, dir);
    out.push(
      serial
        ? `tests took ${fmtMs(testRow.ms)} on one worker; ${serial}`
        : `tests took ${fmtMs(testRow.ms)}; find the slowest tests (pytest --durations=30, node --test --test-reporter=spec) and fix their cause: sleeps, real subprocesses or network, fixtures rebuilt per test`,
    );
  }
  const commands = { ...config.checks, ...(testInChecks ? {} : { test: config.testCommand }) };
  for (const d of duplicateWork(commands, dir)) out.push(`${d.names.join(' and ')} both run "${d.part}"; run it in one check only`);
  return out.map((output) => ({ name: 'speed', kind: 'advice', pass: true, output }));
}

/**
 * Setup advice from the config alone (REQ-CLI-15): without testFilesCommand, red proof reruns the whole suite on
 * base for every bug or feature gate (REQ-GATE-33). Warnings only; they never fail the doctor.
 */
export function setupAdvice(config) {
  const advice = [];
  if (!config.testFilesCommand)
    advice.push(
      'testFilesCommand is not set: red proof reruns the whole test suite on every bug or feature gate; set it in keel.json to a command that runs only {files} (for example "node --test {files}" or "python -m pytest {files}")',
    );
  // A subscription is not billed per token; its plan windows are the ceiling, and planLimits guards them (REQ-PLAN-4).
  if (config.dailyBudgetUsd !== null && config.tiers.some((t) => t.provider === 'claude' || t.provider === 'codex'))
    advice.push(
      `dailyBudgetUsd ${config.dailyBudgetUsd} counts list-price estimates, not what a Claude or Codex subscription charges, and stops the poll early; planLimits (${config.planLimits ? `5h ${config.planLimits.fiveHour}%, week ${config.planLimits.week}%` : 'off'}) guards the plan windows: remove dailyBudgetUsd unless the tiers bill an API key`,
    );
  return advice;
}

/**
 * Required status checks on a branch, from classic branch protection and from rulesets (REQ-CLI-4). Without any,
 * GitHub auto-merge would merge at once, before CI, so a gh error or a 404 counts as none (fail safe).
 */
function requiredCheckCount(repo, branch) {
  const queries = [
    [
      `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
      '(.contexts | length) + (.checks | length)',
    ],
    [`repos/{owner}/{repo}/rules/branches/${encodeURIComponent(branch)}`, '[.[] | select(.type == "required_status_checks")] | length'],
  ];
  let count = 0;
  for (const [path, jq] of queries) {
    const r = exec('gh', ['api', path, '--jq', jq], repo);
    if (r.status === 0) count += Number(r.stdout.trim()) || 0;
  }
  return count;
}

/** Whether `--merge` may enable auto-merge here (REQ-CLI-4): review on, and required checks on the base branch. */
export function mergeReadiness({ repo, branch, config }) {
  if (!config.review) return { ready: false, reason: 'review is off in keel.json (auto-merge needs tested and reviewed changes)' };
  // `fallback`: GitHub auto-merge is unavailable here, so `keel poll --merge` may merge the certified SHA itself (REQ-MERGE-1).
  if (requiredCheckCount(repo, branch) === 0) return { ready: false, reason: `no required status checks on ${branch}`, fallback: true };
  const auto = exec('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge == true'], repo);
  // Only an explicit true counts; an error, empty output, `false`, or `null` fails safe (REQ-CLI-4).
  if (auto.status !== 0 || ['', 'false', 'null'].includes(auto.stdout.trim())) {
    return { ready: false, reason: 'auto-merge is off in the repository settings', fallback: true };
  }
  return { ready: true, reason: null };
}

/**
 * Whether the branch requires the `keel/gate` status, from classic protection or rulesets (REQ-CLI-4). Without it,
 * GitHub keeps auto-merge on after a later push, so an ungated head can merge. A gh error counts as no (fail safe).
 */
export function keelGateRequired(repo, branch) {
  const queries = [
    [
      `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
      '[(.contexts // [])[], (.checks // [])[].context] | index("keel/gate") != null',
    ],
    [
      `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(branch)}`,
      '[.[] | select(.type == "required_status_checks") | (.parameters.required_status_checks // [])[].context] | index("keel/gate") != null',
    ],
  ];
  return queries.some(([path, jq]) => {
    // Rulesets can span pages; any page that names keel/gate counts.
    const r = exec('gh', ['api', '--paginate', path, '--jq', jq], repo);
    return r.status === 0 && r.stdout.split('\n').some((l) => l.trim() === 'true');
  });
}

/** Linear's Free plan allows 250 issues; archived issues do not count, and at the limit no issue can be created (REQ-CLI-16). */
export const LINEAR_ISSUE_LIMIT = 250;
const LINEAR_WARN_AT = 200;

/**
 * Doctor lines for the Linear workspace's room for new issues (REQ-CLI-16): `open` unarchived issues against
 * LINEAR_ISSUE_LIMIT (WARN from 200, FAIL at the limit), and each team's auto-archive period in months (WARN above 1).
 */
export function linearCapacity({ open, teams }) {
  const count = `linear ${open} of ${LINEAR_ISSUE_LIMIT} unarchived issues`;
  const rows = [
    open >= LINEAR_ISSUE_LIMIT
      ? { level: 'FAIL', text: `${count}: Linear refuses new issues, so keel poll cannot file follow-ups; archive closed issues` }
      : open >= LINEAR_WARN_AT
        ? { level: 'WARN', text: `${count}: archive closed issues before Linear refuses new ones at ${LINEAR_ISSUE_LIMIT}` }
        : { level: 'INFO', text: count },
  ];
  for (const t of teams) {
    const after = `linear team ${t.key} auto-archives closed issues after ${t.autoArchivePeriod} month${t.autoArchivePeriod === 1 ? '' : 's'}`;
    rows.push(
      t.autoArchivePeriod > 1
        ? { level: 'WARN', text: `${after}; set 1 so closed issues stop counting sooner` }
        : { level: 'INFO', text: after },
    );
  }
  return rows;
}

/**
 * The doctor's Linear lines (REQ-CLI-16): nothing without LINEAR_API_KEY; else each linearCapacity row is logged as
 * `<LEVEL> <text>`. Returns true when a row is FAIL, so the doctor exits 1. A read error is logged as a WARN and does
 * not fail the doctor: Linear being down does not make the repo unhealthy, but it is shown.
 */
export async function linearDoctor({ env, client, log }) {
  if (!env.LINEAR_API_KEY) return false;
  let usage;
  try {
    usage = await client().capacity();
  } catch (e) {
    log(`WARN linear capacity unknown: ${e.message}`);
    return false;
  }
  const rows = linearCapacity(usage);
  for (const r of rows) log(`${r.level} ${r.text}`);
  return rows.some((r) => r.level === 'FAIL');
}
