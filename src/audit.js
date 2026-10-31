import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { changedFiles, exec, git } from './git.js';
import { appendJsonl, readJsonl, stateDir } from './ledger.js';
import { queueFollowUps } from './poll.js';
import { reviewStage } from './review.js';
import { spendFile } from './window.js';

const auditFile = () => join(stateDir(), 'audit.jsonl');
const label = (t) => `${t.provider}/${t.model}/${t.effort}`;
// A routine-diff review (REQ-GATE-45) is a choice, not an outage: the audit leaves it alone.
export const FALLBACK = /\(fallback: (\S+) (?!routine diff)/;

function gh(args, repo) {
  const r = exec('gh', args, repo);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${`${r.stdout}${r.stderr}`.trim()}`);
  return JSON.parse(r.stdout);
}

/**
 * Merged PRs of the last `days` (REQ-CLI-12) whose keel/gate status names a fallback reviewer (REQ-GATE-22), newest
 * first, with the reviewer that was out. A merge `done` lists is skipped without an API call; one whose gate names no
 * fallback is recorded as scanned, so no later audit fetches its statuses again.
 */
function fallbackMerges(repo, limit, days, done) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const prs = gh(
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--search',
      `merged:>=${since}`,
      '--limit',
      String(limit),
      '--json',
      'number,title,body,headRefOid,mergeCommit',
    ],
    repo,
  );
  const out = [];
  for (const pr of prs) {
    if (!pr.mergeCommit?.oid || done.has(pr.mergeCommit.oid)) continue;
    const statuses = gh(['api', `repos/{owner}/{repo}/commits/${pr.headRefOid}/statuses?per_page=100`], repo);
    const gate = statuses.find((s) => s.context === 'keel/gate');
    const m = FALLBACK.exec(gate?.description ?? '');
    if (m) out.push({ pr: pr.number, title: pr.title, body: pr.body ?? '', sha: pr.mergeCommit.oid, from: m[1] });
    else
      appendJsonl(auditFile(), {
        repo: resolve(repo),
        repository: repositoryOf(repo),
        pr: pr.number,
        sha: pr.mergeCommit.oid,
        scanned: 'no fallback review',
        at: new Date().toISOString(),
      });
  }
  return out;
}

/** One id for a repository across its checkouts, linked worktrees, and symlinks: its real git common dir (REQ-CLI-12). */
const repositoryOf = (repo) => realpathSync(resolve(repo, git(['rev-parse', '--git-common-dir'], repo).trim()));

/** The repository of a row written before REQ-CLI-12, which names only its checkout; null once that checkout is gone. */
function legacyRepository(path) {
  if (!existsSync(path)) return null;
  const r = exec('git', ['rev-parse', '--git-common-dir'], path);
  return r.status === 0 ? realpathSync(resolve(path, r.stdout.trim())) : null;
}

/** Merges already audited or scanned in `repo`'s repository; a commit can be in more than one (a fork, a moved history). */
function audited(repo) {
  const id = repositoryOf(repo);
  const legacy = new Map();
  const of = (r) => {
    if (r.repository) return r.repository;
    if (!legacy.has(r.repo)) legacy.set(r.repo, legacyRepository(r.repo) ?? r.repo);
    return legacy.get(r.repo);
  };
  return new Set(
    readJsonl(auditFile())
      .filter((r) => of(r) === id)
      .map((r) => r.sha),
  );
}

/**
 * `keel audit` (REQ-CLI-11): review each merged PR that only a fallback reviewer saw (REQ-GATE-22) again, with the
 * reviewer that was out, once it answers. Findings at `reviewBlock` or above join the found-work queue (REQ-LINEAR-22)
 * under the issue the PR closes, or with no source when it closes none, so the next poll files them; notes below
 * `reviewBlock` are reported and recorded, never filed (REQ-CLI-17). Each audited merge is recorded in
 * audit.jsonl and never reviewed again; an unavailable reviewer records nothing, so the next audit retries.
 */
export function audit({ repo, config, limit = 500, days = 30 }) {
  const results = [];
  for (const m of fallbackMerges(repo, limit, days, audited(repo))) {
    const reviewer = config.tiers.find((t) => label(t) === m.from) ?? null;
    if (!reviewer) {
      results.push({ ...m, outcome: 'no-reviewer' });
      continue;
    }
    git(['cat-file', '-e', `${m.sha}^{commit}`], repo); // a merge not fetched yet fails visibly here
    const base = `${m.sha}^1`;
    const card = {
      id: `PR-${m.pr}`,
      title: m.title,
      kind: 'chore',
      size: 'S',
      paths: [],
      allowEdits: [],
      acceptance: [],
      heldOut: null,
      text: `# ${m.title}\n\n${m.body}`,
    };
    const r = reviewStage({
      repo,
      base,
      head: m.sha,
      card,
      config: { ...config, review: true, reviewFallback: false },
      changed: changedFiles(base, m.sha, repo),
      reviewer,
      spendFile: spendFile(), // audits spend the same window as gates (REQ-GATE-24)
    });
    if (r.problems.some((p) => p.rule === 'review-unavailable')) {
      results.push({ pr: m.pr, sha: m.sha, outcome: 'unavailable', reviewer: r.reviewer });
      break; // the provider is out; the rest waits for the next audit
    }
    // Only findings at or above reviewBlock are filed; notes below it stay in audit.jsonl and the output (REQ-CLI-17).
    const blocking = r.problems.filter((p) => p.rule === 'review-finding');
    const findings = [...blocking, ...(r.notes ?? [])];
    const source = /Closes\s+([A-Z]+-\d+)/.exec(m.body)?.[1] ?? null;
    if (blocking.length)
      queueFollowUps(
        resolve(repo),
        source,
        blocking.map((f) => ({
          kind: 'bug',
          title: `Audit #${m.pr}: ${f.text}`.slice(0, 200),
          detail: `${f.severity} ${f.path}:${f.line}`,
        })),
        m.sha, // the finding is about this merge; filing compares it with the base HEAD (REQ-LINEAR-27)
        `#${m.pr}`,
      );
    const row = {
      repo: resolve(repo),
      repository: repositoryOf(repo),
      pr: m.pr,
      sha: m.sha,
      reviewer: r.reviewer,
      findings,
      source,
      cost: r.cost ?? null,
      at: new Date().toISOString(),
    };
    appendJsonl(auditFile(), row);
    results.push({
      pr: m.pr,
      sha: m.sha,
      outcome: blocking.length ? 'findings' : 'pass',
      reviewer: r.reviewer,
      findings,
      queued: blocking.length,
      source,
    });
  }
  return results;
}
