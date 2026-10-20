import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendJsonl, readJsonl, stateDir } from './ledger.js';
import { cachedPlan } from './plan.js';

/** A window with this share of its tokens left or less counts as nearly used (REQ-GATE-24). */
export const WINDOW_RESERVE = 0.1;

/** Review spend of every session on this machine, one JSON line per review (REQ-GATE-24). */
export const spendFile = () => join(stateDir(), 'review-spend.jsonl');

export function recordReviewSpend(file, family, usage, now = new Date()) {
  if (!file || !usage) return;
  const tokens = usage.in + (usage.cacheWrite ?? 0) + usage.out;
  appendJsonl(file, { at: now.toISOString(), family, tokens });
}

/** Window length assumed for a learned limit: Codex and Claude plans both meter usage over 5 hours (REQ-GATE-27). */
export const LEARNED_HOURS = 5;

const limitsFile = (file) => join(dirname(file), 'review-limits.json');
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});

function spentSince(file, family, since) {
  const rows = readJsonl(file);
  return rows.filter((r) => r.family === family && Date.parse(r.at) > since).reduce((n, r) => n + r.tokens, 0);
}

/**
 * On a quota failure, keep what the family spent in the last LEARNED_HOURS as its observed limit (REQ-GATE-27), so the
 * next gate moves to the fallback before the quota runs out with no configuration. No recorded spend teaches nothing.
 */
export function learnLimit(file, family, now = new Date()) {
  if (!file) return;
  const tokens = spentSince(file, family, now.getTime() - LEARNED_HOURS * 3600 * 1000);
  if (!(tokens > 0)) return;
  const limits = readJson(limitsFile(file));
  limits[family] = { hours: LEARNED_HOURS, tokens, at: now.toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(limitsFile(file), `${JSON.stringify(limits, null, 1)}\n`);
}

/**
 * Estimated use of one family's quota window (REQ-GATE-24): the spend recorded in the last `hours`, against the
 * configured token budget, else the limit learned from a quota failure (REQ-GATE-27, marked `learned`). Null when
 * neither is known. A rolling count, not the provider's own meter, so it is an estimate.
 */
export function windowUse(file, family, windows, now = new Date()) {
  if (!file) return null;
  // The provider's own meter, when a fresh reading exists, wins over any token estimate (REQ-PLAN-5): on 2026-10-20 a
  // learned limit of 454k tokens sent every review to the fallback while Codex reported 7 % of its window used.
  const plan = cachedPlan(dirname(file), family, now);
  const pct = plan && Math.max(...[plan.fiveHour, plan.week].filter(Boolean).map((w) => w.used));
  if (Number.isFinite(pct)) return { family, plan: true, used: pct, limit: 100, remaining: 100 - pct };
  const set = windows[family];
  const learned = set ? null : readJson(limitsFile(file))[family];
  const w = set ?? (learned ? { hours: learned.hours, tokens: learned.tokens } : null);
  if (!w) return null;
  const used = spentSince(file, family, now.getTime() - w.hours * 3600 * 1000);
  return { family, hours: w.hours, limit: w.tokens, remaining: Math.max(0, w.tokens - used), ...(learned ? { learned: true } : {}) };
}

export const nearlyUsed = (use) => use !== null && use.remaining <= use.limit * WINDOW_RESERVE;

/**
 * The estimate `keel gate` prints (REQ-GATE-24). `first` is the label of the fallback that reviews first, `reviewer`
 * the label of the reviewer; a nearly used window names whichever of them reviews first, and with no `first`, `why`
 * says why the reviewer still reviews.
 */
export const windowLine = (use, { first, reviewer, why = 'no fallback has room' }) =>
  `review window ${use.family}${
    use.plan
      ? ` (plan): ${use.used}% used`
      : `${use.learned ? ' (learned)' : ''}: ~${use.remaining} of ${use.limit} tokens left in ${use.hours}h`
  }${nearlyUsed(use) ? ` (nearly used: ${first ? `fallback ${first} reviews first` : `${why}, ${reviewer} still reviews`})` : ''}`;

/**
 * `keel doctor`'s window rows (REQ-GATE-27): one per reviewer family of the tiers whose window is set or learned.
 */
export function windowLines(config, file) {
  const families = [...new Set(config.tiers.map((t) => t.family ?? t.provider))];
  return families
    .map((f) => windowUse(file, f, config.reviewWindows))
    .filter(Boolean)
    .map((use) => windowLine(use, { first: null, reviewer: use.family }).replace(/ \(nearly used: .*\)$/, ' (nearly used)'));
}
