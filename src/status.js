import { exec } from './git.js';
import { outLine } from './review.js';

export const GATE_CONTEXT = 'keel/gate';

/** The review-unavailable problem when that is the only reason a gate failed, else undefined. */
const unavailable = (receipt) =>
  receipt.pass ? undefined : receipt.results.find((r) => !r.pass)?.problems.find((p) => p.rule === 'review-unavailable');

/**
 * The status state (REQ-CLI-10): `success` on a pass; `error` when the reviewer was unavailable, since the change was
 * not judged; else `failure`.
 */
export const gateState = (receipt) => (receipt.pass ? 'success' : unavailable(receipt) ? 'error' : 'failure');

/**
 * The status description: what passed, or the first stage that failed (REQ-RUN-23, REQ-CLI-10). GitHub shows at
 * most 140 characters.
 */
export function gateDescription(receipt, config) {
  const failed = receipt.results.find((r) => !r.pass);
  const outage = unavailable(receipt);
  // Every reviewer that was out, with its status and reset time (REQ-GATE-26).
  if (outage && failed.unavailable?.length) return `review unavailable: ${failed.unavailable.map(outLine).join('; ')}`.slice(0, 140);
  if (outage) return `review unavailable (${outage.status ?? 'no verdict'}); gate again later`;
  if (failed) {
    const rule = failed.problems[0]?.rule;
    return `failed at ${failed.name}${rule ? `: ${rule}` : ''}`.slice(0, 140);
  }
  const review = receipt.results.find((r) => r.name === 'review');
  return (
    review
      ? `passed; review by ${review.reviewer}${review.fallback ? ` (fallback: ${review.fallback.from} ${review.fallback.status})` : ''}`
      : config.review
        ? 'passed'
        : 'passed; review off in keel.json'
  ).slice(0, 140);
}

/**
 * Post the `keel/gate` commit status on the gated SHA (REQ-RUN-23, REQ-CLI-10). A branch protection rule that requires
 * it blocks a merge of any later head, because a new SHA has no status (closes the auto-merge gap of REQ-RUN-20).
 */
export function postGateStatus(repo, receipt, config) {
  const r = exec(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/statuses/${receipt.head}`,
      '-f',
      `state=${gateState(receipt)}`,
      '-f',
      `context=${GATE_CONTEXT}`,
      '-f',
      `description=${gateDescription(receipt, config)}`,
    ],
    repo,
  );
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}
