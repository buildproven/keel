import { ALREADY_SATISFIED } from './done.js';
import { exec } from './git.js';

// Poll-ledger outcomes that are not a run of the issue: found work, filing, and polls that ran nothing (REQ-LED-14).
// Self-merge bookkeeping rows (REQ-MERGE-2, -3) record what happened to a run's PR, not a run (REQ-LED-16).
const NOT_A_RUN = new Set([
  'found',
  'filed',
  'dup',
  'stale',
  'file-error',
  'held', // filing waits for room in the Linear workspace (REQ-LINEAR-37)
  'skipped',
  'leased',
  'budget',
  'plan', // plan windows over planLimits (REQ-PLAN-3)
  'none',
  'followUpsFailed',
  'self-merge',
  'self-merged',
  'self-merge-closed',
  'refined', // the refine step before a build (REQ-LINEAR-33)
  'split', // the issue became sub-issues; each is a run of its own (REQ-LINEAR-33)
]);
// Outcomes that stop for a human or hand the issue to one (REQ-LINEAR-5, -15, -16, -18).
const STOPS = new Set([
  'blocked',
  'failed',
  'needsReview',
  'needsHuman',
  'prFailed',
  'reportFailed',
  'closedMeanwhile',
  'self-merge-failed',
]);
const HUMAN_MERGE = new Set(['inReview']); // Keel moved it to review; a person merged it
// An `--issue` run's poll row has `byHand: true` (REQ-LINEAR-14); rows before 2026-10-17 had this detail instead.
const LEGACY_BY_HAND = 'explicit --issue retry';
const byHand = (r) => r.byHand === true || r.detail === LEGACY_BY_HAND;
// Before `--merge` (2026-10-06) every pass waited for a human merge, and `closed` is an outcome no poll writes any more:
// neither says anything about Keel today (REQ-LED-16).
const MERGE_FLAG_SINCE = Date.parse('2026-10-06T00:00:00Z');
const legacy = (r) => r.outcome === 'closed' || (r.outcome === 'inReview' && Date.parse(r.at) < MERGE_FLAG_SINCE);
const DAY_MS = 86400000;
const REASONS = [
  'stopped for a human',
  'retried by hand',
  'merged by a human',
  'commit after the gate',
  'human review or comment',
  'closed without a merge',
];

/** `gh api graphql --paginate --slurp` of `query` with `vars` (`-f`, or `-F` for an Int): its pages. Throws with gh's reason. */
function graphqlPages(repo, query, vars) {
  const flags = Object.entries(vars).flatMap(([k, v]) => [typeof v === 'number' ? '-F' : '-f', `${k}=${v}`]);
  const r = exec('gh', ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, ...flags], repo);
  if (r.status !== 0) throw new Error(`gh api graphql: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  return JSON.parse(r.stdout);
}

const AUTHOR = 'author { __typename login }';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

/**
 * Open, merged, and closed PRs of the repo's GitHub remote with every review and comment author's GraphQL type, so a
 * bot (`Bot`) is told from a person (anything else, an unknown author included). A PR with more than 100 comments or
 * reviews has the rest read page by page, so no person past the first 100 is missed. Throws with gh's reason
 * (REQ-LED-14).
 */
export function githubPrs(repo) {
  const view = exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], repo);
  if (view.status !== 0) throw new Error(`gh repo view: ${(view.stderr || view.error?.message || '').trim().split('\n')[0]}`);
  const [owner, name] = view.stdout.trim().split('/');
  // gh --paginate follows the first pageInfo in the reply, so the PR list's comes before the nested ones.
  const query = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $endCursor) {
      ${PAGE_INFO}
      nodes { number headRefName headRefOid state comments(first: 100) { ${PAGE_INFO} nodes { ${AUTHOR} } } reviews(first: 100) { ${PAGE_INFO} nodes { ${AUTHOR} } } }
    }
  }
}`;
  // The rest of one PR's comments or reviews, after the first page's cursor.
  const rest = (number, field, after) =>
    graphqlPages(
      repo,
      `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${field}(first: 100, after: $endCursor) { ${PAGE_INFO} nodes { ${AUTHOR} } } }
  }
}`,
      { owner, name, number, endCursor: after },
    ).flatMap((page) => page.data.repository.pullRequest[field].nodes);
  const all = (p, field) => [
    ...p[field].nodes,
    ...(p[field].pageInfo?.hasNextPage ? rest(p.number, field, p[field].pageInfo.endCursor) : []),
  ];
  const who = (n) => ({ type: n.author?.__typename ?? 'unknown', login: n.author?.login ?? null });
  return graphqlPages(repo, query, { owner, name })
    .flatMap((page) => page.data.repository.pullRequests.nodes)
    .map((p) => ({
      head: p.headRefName,
      headOid: p.headRefOid,
      state: p.state,
      authors: [...all(p, 'comments'), ...all(p, 'reviews')].map(who),
    }));
}

/** Whether the issue's first run (a deferral is not one) was an `--issue` run: a human start (REQ-LED-16). */
const startedByHand = (rows) => {
  const first = rows.find((r) => r.outcome !== 'deferred');
  return Boolean(first && byHand(first));
};

/** Why a human touched this issue, `pending` while its PR waits to merge, or null when no human did (REQ-LED-14, -16). */
function touchOf(id, rows, certified, prs) {
  const first = rows.findIndex((r) => r.outcome !== 'deferred');
  if (rows.some((r, i) => i > first && byHand(r))) return 'retried by hand';
  const outcomes = rows.map((r) => r.outcome);
  if (outcomes.some((o) => STOPS.has(o))) return 'stopped for a human';
  if (outcomes.some((o) => HUMAN_MERGE.has(o))) return 'merged by a human';
  if (outcomes.includes('alreadyDone')) return null; // Keel proved it done and closed it (REQ-LINEAR-30)
  const mine = prs().filter((p) => p.head === `keel/${id}`);
  const merged = mine.findLast((p) => p.state === 'MERGED');
  if (!merged) return mine.some((p) => p.state === 'OPEN') || outcomes.at(-1) === 'deferred' ? 'pending' : 'closed without a merge';
  if (!certified.has(merged.headOid)) return 'commit after the gate';
  if (merged.authors.some((a) => a.type !== 'Bot')) return 'human review or comment';
  return null;
}

/**
 * The human touch rate (REQ-LED-14, G3): of the issues `keel poll` ran, the share a human had to touch. Keel's own
 * commits share the machine's git identity with the owner's other agents, so a commit is Keel's when the merged head
 * is one the gate certified, not by its author. `prsFor(repo)` lists a repo's PRs (`githubPrs` by default). With
 * `windowDays`, only issues whose latest poll row is that recent count (REQ-LED-16); legacy rows and not-keel issues
 * never count.
 */
export function humanTouch({ pollRows, ledgerRows, prsFor = githubPrs, windowDays = null, now = new Date() }) {
  const since = windowDays ? new Date(now.getTime() - windowDays * DAY_MS) : null;
  const key = (r) => `${r.repo}\0${r.issue}`;
  const notKeel = new Map(); // key → latest notKeel row (REQ-LINEAR-25)
  for (const r of pollRows) if (r.outcome === 'notKeel') notKeel.set(key(r), r);
  const byIssue = new Map();
  for (const r of pollRows) {
    if (NOT_A_RUN.has(r.outcome) || r.outcome === 'notKeel' || legacy(r) || notKeel.has(key(r))) continue;
    byIssue.set(key(r), [...(byIssue.get(key(r)) ?? []), r]);
  }
  const inWindow = (r) => !since || Date.parse(r.at) >= since.getTime();
  for (const [k, rows] of byIssue) if (!inWindow(rows.at(-1))) byIssue.delete(k);
  const prCache = new Map();
  const prsOf = (repo) => {
    if (!prCache.has(repo)) {
      try {
        prCache.set(repo, { prs: prsFor(repo) });
      } catch (e) {
        // REQ-LED-14: a repo gh cannot read is reported with its reason; its issues are unknown, not untouched.
        prCache.set(repo, { error: e.message });
      }
    }
    const got = prCache.get(repo);
    if (got.error) throw Object.assign(new Error(got.error), { unknownRepo: repo });
    return got.prs;
  };
  const out = {
    issues: 0,
    touched: 0,
    pending: 0,
    unknown: new Map(),
    reasons: {},
    stops: stopsOf(ledgerRows, byIssue),
    started: { issues: 0, clean: 0 },
    notKeel: [...notKeel.values()].filter(inWindow).length,
    window: since ? { days: windowDays, since: since.toISOString().slice(0, 10) } : null,
  };
  for (const rows of byIssue.values()) {
    if (rows.every((r) => r.outcome === 'deferred')) continue; // not decided yet
    const { repo, issue } = rows[0];
    const certified = new Set(ledgerRows.filter((r) => r.repo === repo && r.card === issue && r.attemptPass && r.head).map((r) => r.head));
    let why;
    try {
      why = touchOf(issue, rows, certified, () => prsOf(repo));
    } catch (e) {
      if (!e.unknownRepo) throw e;
      const u = out.unknown.get(repo) ?? { count: 0, reason: e.message };
      out.unknown.set(repo, { ...u, count: u.count + 1 });
      continue;
    }
    if (why === 'pending') {
      out.pending += 1;
      continue;
    }
    out.issues += 1;
    if (startedByHand(rows)) {
      out.started.issues += 1;
      if (!why) out.started.clean += 1;
    }
    if (why) {
      out.touched += 1;
      out.reasons[why] = (out.reasons[why] ?? 0) + 1;
    }
  }
  out.reasons = Object.fromEntries(REASONS.filter((k) => out.reasons[k]).map((k) => [k, out.reasons[k]]));
  return out;
}

/**
 * Polled issues that stopped for a human (REQ-LED-16), each counted once per reason: a Keel run of its card in its repo
 * whose last attempt blocked (KEEL_BLOCKED) or was not logged in, or a poll `needsReview` decision. Hand-written cards
 * are never polled, so they are not counted.
 */
function stopsOf(ledgerRows, byIssue) {
  const ends = new Map(); // repo\0card → run → last attempt row
  for (const r of ledgerRows) {
    if (!r.run || r.role === 'held-out-author') continue;
    const k = `${r.repo}\0${r.card}`;
    if (!ends.has(k)) ends.set(k, new Map());
    ends.get(k).set(r.run, r);
  }
  const out = { issues: 0, blocked: 0, auth: 0, decision: 0 };
  for (const [k, rows] of byIssue) {
    const outcomes = new Set(rows.map((r) => r.outcome));
    // A KEEL_DONE claim stops the run `blocked`; once poll proved it (alreadyDone) and never reported it unproven
    // (blocked), no human stepped in (REQ-LINEAR-30).
    const proven = outcomes.has('alreadyDone') && !outcomes.has('blocked');
    const last = [...(ends.get(k)?.values() ?? [])].filter((r) => !(proven && ALREADY_SATISFIED.test(r.blockedReason ?? '')));
    const status = last.map((r) => r.workerStatus);
    const hit = {
      blocked: status.includes('blocked'),
      auth: status.includes('auth'),
      decision: rows.some((r) => r.outcome === 'needsReview' || r.outcome === 'needsHuman'), // a refine question (REQ-LINEAR-33)
    };
    for (const [reason, yes] of Object.entries(hit)) if (yes) out[reason] += 1;
    if (Object.values(hit).some(Boolean)) out.issues += 1;
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatTouch({ issues, touched, pending, unknown, reasons, stops, started, notKeel, window }) {
  const rate = issues
    ? `Human touch rate: ${Math.round((touched / issues) * 100)}% (${touched} of ${issues} issues; target under 5%)`
    : 'Human touch rate: n/a (no polled issue yet; target under 5%)';
  const why = Object.entries(reasons).map(([k, n]) => `${k} ${n}`);
  return [
    rate,
    ...(window ? [`  Window: last ${window.days} days (since ${window.since})`] : []),
    ...(why.length ? [`  Why: ${why.join(', ')}`] : []),
    ...(started?.issues
      ? [`  Started by hand: ${plural(started.issues, 'issue')} (${started.clean} merged with no other human step)`]
      : []),
    ...(stops.issues
      ? [
          `  Stops for a human: ${plural(stops.issues, 'issue')} (builder blocked ${stops.blocked}, login ${stops.auth}, decision ${stops.decision})`,
        ]
      : []),
    ...(notKeel ? [`  Not keel work: ${plural(notKeel, 'issue')}`] : []),
    ...(pending ? [`  Waiting to merge: ${plural(pending, 'issue')}`] : []),
    ...[...unknown].map(([repo, u]) => `  Unknown: ${plural(u.count, 'issue')} in ${repo} (${u.reason})`),
  ].join('\n');
}
