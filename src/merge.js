import { exec } from './git.js';
import { readJsonl } from './ledger.js';
import { SELF_MERGE_ROWS, pollLedgerFile, recordPollAttempt } from './linear.js';
import { GATE_CONTEXT } from './status.js';

const OK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`.trim().slice(-500);

/** Record that `keel poll --merge` merges this certified SHA itself once every check on it passes (REQ-MERGE-1). */
export function recordSelfMerge(repo, { issue, pr, sha }) {
  recordPollAttempt(repo, { issue, outcome: 'self-merge', detail: { pr, sha, since: new Date().toISOString() } });
}

/** Self-merges of this repo not yet settled, oldest first (REQ-MERGE-2): a later row for the same PR settles one. */
export function pendingSelfMerges(repo) {
  const open = new Map();
  for (const r of readJsonl(pollLedgerFile())) {
    if (r.repo !== repo || !SELF_MERGE_ROWS.includes(r.outcome)) continue;
    if (r.outcome === 'self-merge') open.set(r.detail.pr, { issue: r.issue, ...r.detail });
    else open.delete(r.detail.pr);
  }
  return [...open.values()];
}

/**
 * The checks on the certified SHA (REQ-MERGE-2): every check run, commit status, and workflow run must have completed
 * successfully, and `keel/gate` must be among them. Returns { failed, waiting } as lists of names.
 */
function checkState(repo, rollup, sha) {
  const failed = [];
  const waiting = [];
  let gate = false;
  for (const c of rollup ?? []) {
    if (c.__typename === 'StatusContext') {
      if (c.context === GATE_CONTEXT && c.state === 'SUCCESS') gate = true;
      if (c.state === 'SUCCESS') continue;
      (['PENDING', 'EXPECTED'].includes(c.state) ? waiting : failed).push(c.context);
    } else {
      if (c.status !== 'COMPLETED') waiting.push(c.name);
      else if (!OK_CONCLUSIONS.has(c.conclusion)) failed.push(c.name);
    }
  }
  if (!gate) waiting.push(GATE_CONTEXT);
  // A workflow run exists before its check runs do; a queued one is waiting, not absent (REQ-MERGE-2). Every page is
  // read, so a run past the first cannot be missed (REQ-MERGE-7).
  const runs = exec(
    'gh',
    [
      'api',
      '--paginate',
      `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=100`,
      '--jq',
      '[.workflow_runs[] | {name, status, conclusion}]',
    ],
    repo,
  );
  if (runs.status !== 0) waiting.push(`workflow runs (gh api: ${out(runs).slice(0, 200)})`);
  else
    // `--paginate --jq` prints one JSON array per page, each on its own line.
    for (const w of runs.stdout
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => JSON.parse(l))) {
      if (w.status !== 'completed') waiting.push(`workflow ${w.name}`);
      else if (!OK_CONCLUSIONS.has(String(w.conclusion).toUpperCase())) failed.push(`workflow ${w.name}`);
    }
  return { failed, waiting };
}

/**
 * What to do with one pending self-merge now (REQ-MERGE-2..7): `{ act: 'merge' }`, `{ act: 'wait', why }`,
 * `{ act: 'fail', reason }`, `{ act: 'settle', outcome }`, or `{ act: 'skip', why }`.
 */
function decide(repo, p, timeoutMinutes, now) {
  const view = exec('gh', ['pr', 'view', p.pr, '--json', 'state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup'], repo);
  const late = now - Date.parse(p.since) > timeoutMinutes * 60_000;
  const wait = (why) => (late ? { act: 'fail', reason: `checks not green after ${timeoutMinutes} minutes: ${why}` } : { act: 'wait', why });
  if (view.status !== 0) return wait(`the PR (gh pr view: ${out(view).slice(0, 200)})`);
  const pr = JSON.parse(view.stdout);
  if (pr.state === 'MERGED') return { act: 'settle', outcome: 'self-merged' };
  if (pr.state !== 'OPEN') return { act: 'settle', outcome: 'self-merge-closed' };
  if (pr.headRefOid !== p.sha) return { act: 'fail', reason: `head ${pr.headRefOid} is not the certified ${p.sha}` };
  // A conflict is REQ-LINEAR-23's: the poll closes the PR and builds the issue again.
  if (pr.mergeable === 'CONFLICTING') return { act: 'skip', why: 'conflicts with its base; left to the conflict rebuild' };
  if (pr.isDraft) return { act: 'fail', reason: 'the PR is a draft' };
  const { failed, waiting } = checkState(repo, pr.statusCheckRollup, p.sha);
  if (failed.length) return { act: 'fail', reason: `check ${failed.join(', ')} failed` };
  // Keel never moves the certified head, so a branch that must be up to date cannot become mergeable by waiting,
  // even for a check still pending (REQ-MERGE-6).
  if (pr.mergeStateStatus === 'BEHIND')
    return { act: 'fail', reason: 'the branch is behind its base, and Keel never changes the certified head' };
  if (waiting.length) return wait(waiting.join(', '));
  if (!MERGEABLE_STATES.has(pr.mergeStateStatus)) return wait(`merge state ${pr.mergeStateStatus}`);
  return { act: 'merge' };
}

/**
 * Finish pending self-merges (REQ-MERGE-2..7), at the start of `keel poll --merge`: merge each whose checks are all
 * green with `gh pr merge --squash --match-head-commit <certified sha>`, report each that cannot merge on the PR and
 * the issue, and leave the rest pending for a later poll, so no repo's poll waits on CI. Returns poll results:
 * `merged` and `mergeFailed` (the poll then exits 1).
 */
export async function finishSelfMerges({ repo, config, client, log, now = Date.now() }) {
  const results = [];
  for (const p of pendingSelfMerges(repo)) {
    let d = decide(repo, p, config.selfMergeTimeoutMinutes, now);
    if (d.act === 'merge') {
      const m = exec('gh', ['pr', 'merge', p.pr, '--squash', '--match-head-commit', p.sha], repo);
      d =
        m.status === 0 ? { act: 'settle', outcome: 'self-merged', merged: true } : { act: 'fail', reason: `gh pr merge failed: ${out(m)}` };
    }
    if (d.act === 'wait') log(`${p.issue}: self-merge waits for ${d.why}`);
    else if (d.act === 'skip') log(`${p.issue}: self-merge of ${p.pr} ${d.why}`);
    else if (d.act === 'settle') {
      recordPollAttempt(repo, { issue: p.issue, outcome: d.outcome, detail: { pr: p.pr, sha: p.sha } });
      if (d.merged) {
        log(`${p.issue}: merged ${p.pr} at ${p.sha}`);
        results.push({ outcome: 'merged', issue: p.issue });
      } else log(`${p.issue}: ${p.pr} was ${d.outcome === 'self-merged' ? 'merged' : 'closed'} outside Keel; self-merge dropped`);
    } else {
      // Recorded first, so a comment error cannot make the next poll report it again (REQ-MERGE-3).
      recordPollAttempt(repo, { issue: p.issue, outcome: 'self-merge-failed', detail: { pr: p.pr, sha: p.sha, reason: d.reason } });
      const body = `keel: not merged: ${d.reason}. The PR stays open for a human.`;
      log(`${p.issue}: ${body}`);
      const c = exec('gh', ['pr', 'comment', p.pr, '--body', body], repo);
      if (c.status !== 0) log(`${p.issue}: PR comment failed: ${out(c)}`);
      await client.comment(p.issue, body);
      results.push({ outcome: 'mergeFailed', issue: p.issue, detail: d.reason });
    }
  }
  return results;
}
