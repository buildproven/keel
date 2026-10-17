import { doctor } from './doctor.js';
import { exec, revParse } from './git.js';

/** A blocked reason that claims the card is already satisfied (REQ-LINEAR-30), from `KEEL_DONE` or `KEEL_BLOCKED`. */
export const ALREADY_SATISFIED = /\balready satisfied\b/i;

/** The commits (`commit <sha>`) and PRs (`PR #N`, `(#N)`) a reason names as its evidence (REQ-LINEAR-30). */
export function doneEvidence(reason) {
  const commits = [...reason.matchAll(/\bcommit\s+([0-9a-f]{7,40})\b/gi)].map((m) => m[1].toLowerCase());
  const prs = [...reason.matchAll(/(?:\bPR\s*#|\(#)(\d+)\b/gi)].map((m) => Number(m[1]));
  return { commits: [...new Set(commits)], prs: [...new Set(prs)] };
}

const short = (sha) => sha.slice(0, 12);

/** Whether `sha` names a commit that is an ancestor of base (REQ-LINEAR-30). */
function onBase(repo, sha, baseSha) {
  const full = exec('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`], repo);
  if (full.status !== 0) return false;
  return exec('git', ['merge-base', '--is-ancestor', full.stdout.trim(), baseSha], repo).status === 0;
}

/** A PR's state from `gh pr view`, or gh's reason when it cannot say (REQ-LINEAR-30). */
function prState(repo, n) {
  const r = exec('gh', ['pr', 'view', String(n), '--json', 'state,mergeCommit'], repo);
  if (r.status !== 0) return { state: null, reason: `${r.stderr || r.error?.message || ''}`.trim().split('\n')[0] };
  return { state: JSON.parse(r.stdout).state };
}

/**
 * Verify a worker's claim that the card is already satisfied (REQ-LINEAR-30): the commits it names are on base and at
 * least one commit or PR holds, then install and every configured check pass on a clean checkout of base. Returns
 * `{ ok, why, evidence, checks, baseSha }`: `evidence` lists what held, `why` what did not.
 */
export function verifyDone({ repo, base, config, reason }) {
  const { commits, prs } = doneEvidence(reason);
  if (!commits.length && !prs.length) return { ok: false, why: 'the reason names no commit or PR' };
  const baseSha = revParse(base, repo);
  const missing = commits.filter((c) => !onBase(repo, c, baseSha));
  if (missing.length) return { ok: false, why: `commit ${missing.join(', ')} is not on base ${short(baseSha)}` };
  const evidence = commits.map((c) => `commit ${c} is on base`);
  const prNotes = [];
  for (const n of prs) {
    const p = prState(repo, n);
    if (p.state === 'MERGED') evidence.push(`PR #${n} merged`);
    else prNotes.push(`PR #${n} ${p.state ? `is ${p.state}` : `not read (${p.reason})`}`);
  }
  if (!evidence.length) return { ok: false, why: prNotes.join('; ') };
  // The same run as `keel doctor` (REQ-CLI-3): install and every check and the test command on a clean checkout of base.
  const rows = doctor({ repo, base: baseSha, config }).filter((r) => r.kind !== 'acceptance');
  const red = rows.find((r) => !r.pass);
  if (red) return { ok: false, why: `${red.kind} ${red.name} failed on base ${short(baseSha)}` };
  const names = rows.map((r) => r.name);
  return { ok: true, evidence, checks: names, baseSha };
}
