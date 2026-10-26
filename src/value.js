import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTouch, humanTouch } from './autonomy.js';
import { escapedDefects, laterFailures, mainCommits } from './escaped.js';
import { loadConfig } from './config.js';
import { attemptCost, readJsonl, report, stateDir } from './ledger.js';
import { pollLedgerFile } from './linear.js';
import { addUsage, priceUsage } from './workers.js';

const DAY_MS = 86400000;
const pct = (n, d) => `${Math.round((n / d) * 100)}%`;

/**
 * The rows whose `at` is within the last `windowDays` days (REQ-LED-19). Every row Keel writes has `at`; a row with
 * none cannot be dated and is kept, so a hand-built row still counts.
 */
export function inWindow(rows, windowDays, now = new Date()) {
  const since = now.getTime() - windowDays * DAY_MS;
  return rows.filter((r) => r.at === undefined || Date.parse(r.at) >= since);
}

/**
 * Is Keel worth it (REQ-LED-8, DESIGN §8)? The same escaped-defect measure (REQ-LED-6, line-level by REQ-LED-10) for Keel merges and for every
 * other change on the same default branches over the same period, so Keel is judged against the owner's own
 * baseline, not an absolute bar; plus what an accepted card cost. It decides nothing: the owner reads it.
 * Spend and cost by repo count only rows inside the window (REQ-LED-19).
 */
export function value(ledgerRows, { windowDays = 30, prsFor, now = new Date() } = {}) {
  const rows = withReviewUsage(ledgerRows);
  const recent = inWindow(rows, windowDays, now);
  const { merged } = escapedDefects(rows, { windowDays }); // each merge commit once (REQ-LED-6)
  const keelShas = new Set(merged.map((m) => m.mergeSha));
  const baseline = new Map();
  const histories = new Map(merged.map((m) => [`${m.repo}\0${m.ref}`, { repo: m.repo, ref: m.ref }]));
  for (const { repo, ref } of histories.values()) {
    if (!existsSync(repo)) continue;
    const at = rows.filter((r) => r.repo === repo && r.attemptPass).map((r) => Date.parse(r.at));
    const commits = mainCommits(repo, ref, new Date(Math.min(...at) - DAY_MS).toISOString());
    commits.forEach((c, i) => {
      if (keelShas.has(c.sha)) return;
      const { candidates, reverts } = laterFailures(commits, i, repo, windowDays);
      const key = `${repo}\0${c.sha}`;
      baseline.set(key, (baseline.get(key) ?? false) || candidates.length > 0 || reverts.length > 0);
    });
  }
  const other = { changes: baseline.size, followed: [...baseline.values()].filter(Boolean).length };
  return {
    keel: { merged: merged.length, followed: merged.filter((m) => m.candidates.length || m.reverts.length).length },
    other,
    spend: report(recent), // REQ-LED-19: the same window as the lines above and below
    touch: humanTouch({ pollRows: readJsonl(pollLedgerFile()), ledgerRows: rows, prsFor, windowDays, now }), // REQ-LED-16
    routing: routedCost(recent),
  };
}

/**
 * Rows from before `reviewUsage` was recorded (REQ-LED-13) take it from the gate receipts of their card and head that
 * were written during their gate time (a re-gate writes two), so their review spend still counts toward the card.
 * The row is written right after its gate, so `at - gateMs` is no later than the gate's start and no earlier than its
 * first receipt: no slack, or a hand gate of the same card and head just before (or the previous attempt's gate of the
 * same head) would be charged to this attempt.
 * Rows older still name no reviewer either; the receipt names it, and a review it shows with no usage counts as unpriced.
 */
export function withReviewUsage(rows, receiptDir = join(stateDir(), 'receipts')) {
  const need = rows.filter((r) => r.reviewUsage === undefined && r.head && r.at);
  if (!need.length || !existsSync(receiptDir)) return rows;
  const files = readdirSync(receiptDir);
  return rows.map((r) => {
    if (!need.includes(r)) return r;
    const end = Date.parse(r.at);
    const start = end - (r.gateMs ?? 0);
    let usage = null;
    let reviewer = r.reviewer ?? null;
    const prefix = `${r.card}-${r.head}-`; // gate.js names a receipt <card>-<head>-<ms>.json
    for (const file of files.filter((f) => f.startsWith(prefix) && f.endsWith('.json'))) {
      const ms = Number(file.slice(prefix.length, -'.json'.length));
      if (!(ms >= start && ms <= end)) continue;
      const review = JSON.parse(readFileSync(join(receiptDir, file), 'utf8')).results?.find((x) => x.name === 'review');
      usage = addUsage(usage, review?.usage ?? null);
      reviewer = reviewer ?? review?.reviewer ?? null;
    }
    // A review that ran but recorded no usage keeps its reviewer, so the report counts it as unpriced, not as free.
    if (usage) return { ...r, reviewer, reviewUsage: usage };
    return reviewer && !r.reviewer ? { ...r, reviewer } : r;
  });
}

/**
 * Per repo: what the attempts cost at the tiers that ran them, and what the same tokens would have cost at the top
 * (last) tier, from `tiers[].priceInPerM` / `priceOutPerM` / `priceCachedPerM` in the repo's keel.json (REQ-LED-9).
 * Cache reads are priced too, because Claude's `cost` includes them; cache writes (`usage.cacheWrite`) are priced at
 * 1.25x the input price, Anthropic's rate for a 5-minute cache write. An absent price that the tokens need gives `top: null`, never zero. Both sides leave out review spend, so they
 * compare. An attempt with no usage or cost makes its side a lower bound (`incomplete`). `configFor(repo)` returns
 * that repo's config.
 */
export function routedCost(rows, configFor = (repo) => loadConfig(repo, 'HEAD')) {
  const byRepo = new Map();
  for (const r of rows) {
    if (!r.repo) continue;
    const e = byRepo.get(r.repo) ?? {
      repo: r.repo,
      routed: 0,
      tokensIn: 0,
      tokensCacheWrite: 0,
      tokensOut: 0,
      tokensCached: 0,
      usageMissing: false,
      costMissing: false,
    };
    const cost = attemptCost(r); // Codex rows priced by model (REQ-LED-12)
    if (cost === null) e.costMissing = true;
    else e.routed += cost;
    if (r.usage) {
      e.tokensIn += r.usage.in;
      e.tokensCacheWrite += r.usage.cacheWrite ?? 0;
      e.tokensOut += r.usage.out;
      e.tokensCached += r.usage.cached ?? 0;
    } else e.usageMissing = true;
    byRepo.set(r.repo, e);
  }
  return [...byRepo.values()].map((e) => {
    const out = { repo: e.repo, routed: e.routed, routedIncomplete: e.costMissing, top: null, incomplete: e.usageMissing, reason: null };
    let top;
    try {
      top = configFor(e.repo).tiers.at(-1);
    } catch (err) {
      // REQ-LED-9: an unreadable keel.json (or a missing repo) is reported on this repo's line, not fatal for the rest.
      out.reason = err.message;
      return out;
    }
    if (typeof top.priceInPerM !== 'number' || typeof top.priceOutPerM !== 'number')
      out.reason = 'top tier has no priceInPerM/priceOutPerM';
    else if (e.tokensCached && typeof top.priceCachedPerM !== 'number') out.reason = 'top tier has no priceCachedPerM';
    else out.top = priceUsage(top, { in: e.tokensIn, cacheWrite: e.tokensCacheWrite, out: e.tokensOut, cached: e.tokensCached });
    return out;
  });
}

const formatRouted = ({ repo, routed, routedIncomplete, top, incomplete, reason }) =>
  `  ${repo}: routed ${routedIncomplete ? '≥' : ''}$${routed.toFixed(2)}; top tier (estimate) ${
    top === null ? `n/a (${reason})` : `${incomplete ? '≥' : ''}$${top.toFixed(2)}`
  }`;

/** Token counts for people: 950, 1.5k, 110k, 12.3M (REQ-LED-15). */
export function tokens(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${Number((n / 1000).toFixed(1))}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1e6).toFixed(1))}M`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const usd = (n, low) => `${low ? '≥' : ''}$${n.toFixed(2)}`;

/** Plain-language lines first (REQ-LED-15), then the cost per repo (REQ-LED-9). */
export function formatValue({ keel, other, spend, touch, routing = [] }) {
  const s = spend;
  const lines = [
    s.total ? `Finished cards: ${s.accepted} of ${s.total} (${pct(s.accepted, s.total)})` : 'Finished cards: 0 of 0',
    formatTouch(touch),
  ];
  if (s.accepted) {
    const b = s.tokensPerAccepted;
    const rv = s.reviewTokensPerAccepted;
    lines.push(`Tokens per finished card: builder ${tokens(b)} + review ${tokens(rv)} = ${tokens(b + rv)}`);
    const bLow = s.unpriced > 0;
    const rLow = s.reviewUnpriced > 0;
    lines.push(
      `Cost per finished card: builder ${usd(s.builderCostPerAccepted, bLow)} + review ${usd(s.reviewCostPerAccepted, rLow)} = ${usd(s.costPerAccepted, bLow || rLow)}`,
    );
  } else lines.push('Tokens and cost per finished card: n/a (no finished card yet)');
  const missing = [
    ...(s.unpricedNoUsage ? [`${plural(s.unpricedNoUsage, 'attempt')} with no usage (a timeout before any result)`] : []),
    ...(s.unpriced - s.unpricedNoUsage ? [`${plural(s.unpriced - s.unpricedNoUsage, 'attempt')} with no price for the model`] : []),
    ...(s.reviewUnpriced ? [`${plural(s.reviewUnpriced, 'review')} with no usage or price`] : []),
  ];
  if (missing.length) lines.push(`  Not priced: ${missing.join('; ')}`);
  lines.push(
    keel.merged
      ? `Later fixed on the same lines: Keel ${pct(keel.followed, keel.merged)} (${keel.followed} of ${keel.merged}) vs other work ${
          other.changes ? `${pct(other.followed, other.changes)} (${other.followed} of ${other.changes})` : 'n/a (no other change)'
        }`
      : 'Later fixed on the same lines: no Keel change merged yet',
  );
  if (routing.length) lines.push('Cost by repo (what ran vs the same tokens on the top tier):', ...routing.map(formatRouted));
  return lines.join('\n');
}
