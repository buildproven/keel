import { join } from 'node:path';
import { parseCard } from './config.js';
import { appendJsonl, readJsonl, stateDir } from './ledger.js';

export const pollLedgerFile = () => join(stateDir(), 'poll-ledger.jsonl');

/** Poll-ledger rows of the self-merge path (REQ-MERGE-1..4); none is an attempt of the issue (REQ-MERGE-2). */
export const SELF_MERGE_ROWS = ['self-merge', 'self-merged', 'self-merge-failed', 'self-merge-closed'];

// A `refined` row (REQ-LINEAR-33) is the step before a build, not an attempt; the build's own outcome follows it.
const SKIP_ROWS = ['filed', 'found', 'dup', 'stale', 'file-error', 'refined'];

/** Every issue id previously attempted by `keel poll` for this repo (REQ-LINEAR-6). */
export function attemptedIssueIds(repo) {
  // Each issue's latest outcome decides: deferred is retried (REQ-LINEAR-19), also after an earlier outcome, as when a
  // conflicting PR is closed to build again (REQ-LINEAR-23). Found-work rows are not attempts (REQ-LINEAR-22), nor are
  // self-merge rows (REQ-MERGE-2).
  const last = new Map();
  for (const r of readJsonl(pollLedgerFile()))
    if (r.repo === repo && ![...SKIP_ROWS, ...SELF_MERGE_ROWS].includes(r.outcome)) last.set(r.issue, r.outcome);
  return new Set([...last].filter(([, outcome]) => outcome !== 'deferred').map(([id]) => id));
}

/** Follow-up issues filed for this repo today, UTC (REQ-LINEAR-22). */
export function filedToday(repo) {
  const today = new Date().toISOString().slice(0, 10);
  return readJsonl(pollLedgerFile()).filter((r) => r.repo === repo && r.outcome === 'filed' && r.at.startsWith(today)).length;
}

/** How found-work titles compare (REQ-LINEAR-22): case-insensitive, and trimmed, as Linear stores a title. */
export const titleKey = (title) => title.trim().toLowerCase();

/**
 * Found work not yet filed (REQ-LINEAR-22), oldest first. The poll ledger is read in order: a `found` row queues each
 * item whose title (case-insensitive; the first source wins) is not queued yet; a `filed`, `dup`, or `stale` (REQ-LINEAR-27) row settles the queued
 * item with its title, and a `file-error` row counts one try against it; `maxTries` tries settle it too. A row settles only
 * work queued before it, so work found again later is queued again and the Linear dedupe decides. Each item carries its
 * `tries`.
 */
export function pendingFollowUps(repo, maxTries = Infinity) {
  const rows = readJsonl(pollLedgerFile()).filter((r) => r.repo === repo);
  const key = titleKey; // the same work found from two sources is one item
  const pending = new Map();
  for (const r of rows) {
    if (r.outcome === 'found') {
      for (const f of r.detail) if (!pending.has(key(f.title))) pending.set(key(f.title), { source: r.issue, ...f, tries: 0 });
    } else if (['filed', 'dup', 'stale'].includes(r.outcome)) pending.delete(key(r.detail.title));
    else if (r.outcome === 'file-error') {
      const item = pending.get(key(r.detail.title));
      if (item && ++item.tries >= maxTries) pending.delete(key(r.detail.title));
    }
  }
  return [...pending.values()];
}

/** Append one issue-attempt record, scoped to this repo (REQ-LINEAR-6). */
export function recordPollAttempt(repo, { issue, outcome, detail }) {
  appendJsonl(pollLedgerFile(), { repo, issue, outcome, detail: detail ?? null, at: new Date().toISOString() });
}

const LABEL_KIND = { bug: 'bug', feature: 'feature', improvement: 'feature' };
/** A title that describes a failure (REQ-LINEAR-24): an unlabeled bug must not run as a chore, which skips red proof. */
const FAILURE_TITLE =
  /^fix(\(.*\))?!?:|\b(fail(s|ed|ing)?|bug|broken|breaks|crash(es|ed)?|hang(s|ing)?|leak(s|ed)?|wrong|miss(es|ed)|lost|loses|regress(ed|ion)?|incorrect(ly)?|stuck|flaky|ignores|drops|skips)\b/i;
const CHORE_TITLE = /^(docs|chore|style|build|ci)(\(.*\))?!?:/i;

/** The card kind of an issue (REQ-LINEAR-2, REQ-LINEAR-24): a Bug label, else a Feature/Improvement label, else the title. */
function kindOf(issue) {
  const kinds = (issue.labels ?? []).map((l) => LABEL_KIND[l.toLowerCase()]).filter(Boolean);
  if (kinds.includes('bug')) return 'bug';
  if (kinds.length) return kinds[0];
  return !CHORE_TITLE.test(issue.title) && FAILURE_TITLE.test(issue.title) ? 'bug' : 'chore';
}
const sizeFromEstimate = (estimate) => (estimate === undefined || estimate === null || estimate <= 2 ? 'S' : estimate <= 5 ? 'M' : 'L');

// Phrases an issue uses to describe itself as blocked by something outside the codebase (an account,
// billing, or vendor condition that no code change can resolve). Heuristic, not exhaustive: found from
// a real live run (BUI-669, 2026-09-27) that burned 4 model attempts before the gate correctly rejected
// every one, because the issue was never fixable in code. Matched against the whole description, so a
// false positive is possible on an issue that merely discusses such a condition — that is an acceptable
// cost against the alternative of running the model loop on an unfixable issue.
const EXTERNALLY_BLOCKED =
  /\bexternal(?:ly)?[\s-]block|billing (?:block|is blocked|remains blocked)|account payment|spending[\s-]limit|awaiting (?:vendor|billing|account)/i;

const KEEL_BLOCK = /```keel[ \t]*\n([\s\S]*?)```[ \t]*\n?/;

/**
 * A `keel` fenced block in the description carries card header lines that override the derived ones
 * (REQ-LINEAR-12). Unknown keys are left for parseCard to reject; a line that is not `key: value` is
 * rejected here, so a broken block skips the issue instead of running with half a policy.
 */
function splitKeelBlock(issue) {
  const m = issue.description.match(KEEL_BLOCK);
  if (!m) return { headers: {}, rest: issue.description.trim() };
  const headers = {};
  for (const line of m[1].split('\n').filter((l) => l.trim())) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kv) throw new Error(`issue ${issue.id} has a malformed line in its keel block: "${line.trim()}"`);
    headers[kv[1]] = kv[2].trim();
  }
  return { headers, rest: issue.description.replace(KEEL_BLOCK, '').trim() };
}

/**
 * Derive a Keel card from a Linear issue (REQ-LINEAR-2), reusing parseCard as the single source of
 * truth for card shape and validation. Throws when the issue cannot be mapped (REQ-LINEAR-3) — the
 * caller decides what to do with an issue it cannot run.
 */
export function cardFromIssue(issue) {
  if (!issue.description) throw new Error(`issue ${issue.id} has no description`);
  if (EXTERNALLY_BLOCKED.test(issue.description))
    throw new Error(`issue ${issue.id} is blocked by an external/account condition, not a code task`);
  const { headers: block, rest } = splitKeelBlock(issue);
  const derived = { kind: kindOf(issue), size: sizeFromEstimate(issue.estimate) };
  const headers = Object.entries({ ...derived, ...block })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return parseCard(`# ${issue.id}: ${issue.title}\n${headers}\n\n## Requirements\n\n${rest}\n`);
}

/**
 * Text that marks an issue as human work, not a code task (REQ-LINEAR-25), by category: [category, where, pattern].
 * Conservative on purpose, each pattern taken from a real issue that stopped for a human (BUI-1129, 535, 541, 689,
 * 1155): a missed one costs one blocked run; a false one costs a comment and an `--issue` retry.
 */
const NOT_KEEL = [
  ['decision', 'title', /\bdecide\b|\bmake (?:the|a) [\w/ -]{0,30}decision\b/i],
  ['decision', 'description', /^\W*decision (?:for|needed|required)\b[^\n]*/im],
  ['playtest', 'title', /\bplay-?tests?\b/i],
  ['umbrella', 'title', /\b(?:umbrella|epic|tracking issue)\b/i],
  ['umbrella', 'description', /\ball (?:child|sub)[- ]issues (?:are )?(?:complete|done|closed)\b/i],
  ['operator step', 'title', /\b(?:operator|manual) step\b|\bruntime-only\b/i],
  ['operator step', 'description', /\b(?:operator|manual) step\b|\bruntime-only\b|^\W*no code change\b/im],
];

/** Why an issue is not a code task (REQ-LINEAR-25), `{ category, match }`, or null; a `keel` block makes it a card. */
export function notKeelReason(issue) {
  const description = issue.description ?? '';
  if (KEEL_BLOCK.test(description)) return null;
  for (const [category, where, re] of NOT_KEEL) {
    const m = (where === 'title' ? (issue.title ?? '') : description).match(re);
    if (m) return { category, match: m[0].trim().replace(/^\W+/, '') };
  }
  return null;
}

// A prerequisite phrase, then an issue identifier within 60 characters of the same sentence (REQ-LINEAR-26). Keywords
// are case-folded by hand so the identifier stays upper case: `after utf-8` is not an issue.
const PREREQ =
  /\b(?:[Nn]eeds|[Rr]equires|[Aa]fter|[Oo]nce|[Dd]epends on|[Bb]locked (?:on|by)|[Ww]aits? (?:for|on)|[Uu]ntil)\b[^.\n]{0,60}?\b([A-Z][A-Z0-9]*-\d+)\b/g;
const FOUND_BY = /^Found by keel while building [A-Z][A-Z0-9]*-\d+\.?$/gm;

/** Issue identifiers an issue's text names as prerequisites (REQ-LINEAR-26), in order, without itself. */
export function textPrerequisites(issue) {
  const text = `${issue.title ?? ''}\n${(issue.description ?? '').replace(FOUND_BY, '')}`;
  const ids = [...text.matchAll(PREREQ)].map((m) => m[1]).filter((id) => id !== issue.id);
  return [...new Set(ids)];
}

/** The owner's opt-out for tracking and decision issues (REQ-LINEAR-11): never picked, commented on, or recorded. */
const optedOut = (issue) => (issue.labels ?? []).some((l) => l.toLowerCase() === 'no-keel');

/**
 * The next issue to attempt (REQ-LINEAR-1): open issues sorted by priority (lower number = higher
 * priority; 0/none last) then age, skipping ids already attempted. An issue that fails to map to a
 * card is skipped and reported via onSkip(id, reason) rather than picked (REQ-LINEAR-3); one whose text marks it as
 * human work is reported via onNotKeel(id, { category, match }) (REQ-LINEAR-25). An issue an open issue
 * still blocks waits (REQ-LINEAR-20): reported via onWait(id, blockers), never skipped for good, so the
 * dependency graph sets the build order.
 */
export function pickIssue(issues, attemptedIds, onSkip = () => {}, onWait = () => {}, onNotKeel = () => {}) {
  const rank = (i) => (i.priority ? i.priority : 99);
  const sorted = [...issues].sort((a, b) => rank(a) - rank(b) || new Date(a.createdAt) - new Date(b.createdAt));
  for (const issue of sorted) {
    if (attemptedIds.has(issue.id) || optedOut(issue)) continue;
    const human = notKeelReason(issue);
    if (human) {
      onNotKeel(issue.id, human);
      continue;
    }
    if (issue.blockedBy?.length) {
      onWait(issue.id, issue.blockedBy);
      continue;
    }
    try {
      cardFromIssue(issue);
      return issue;
    } catch (err) {
      onSkip(issue.id, err.message.replace(`issue ${issue.id} `, '').replace(/^has /, ''));
    }
  }
  return null;
}
