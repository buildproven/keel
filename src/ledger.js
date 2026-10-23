import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULTS } from './config.js';
import { priceUsage } from './workers.js';

export const stateDir = () => process.env.KEEL_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'keel');

const ledgerFile = () => join(stateDir(), 'ledger.jsonl');

const warn = (m) => process.stderr.write(`keel: ${m}\n`);

/** One JSON value, or undefined when the text is not one (JSON.parse throws only SyntaxError here; REQ-LED-1). */
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Rows of a JSONL state file (ledger, poll ledger, audit, review spend; REQ-LED-1). Several processes append to these
 * at once, so a bad line never stops a reader and nothing is ever rewritten. A line that does not parse is a write in
 * progress or a crash leftover. When a later whole row was appended onto a cut-off fragment, that row is recovered
 * from the line's end. Otherwise the line is skipped with a warning that names the file and line.
 */
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line) continue;
    const row = parsed(line);
    if (row !== undefined) {
      rows.push(row);
      continue;
    }
    let at = line.indexOf('{', 1);
    while (at !== -1 && parsed(line.slice(at)) === undefined) at = line.indexOf('{', at + 1);
    if (at === -1) warn(`${file}:${i + 1} does not parse (a write in progress or a crash leftover); skipped`);
    else {
      warn(`${file}:${i + 1} starts with a cut-off write; skipped it and kept the row after it`);
      rows.push(parsed(line.slice(at)));
    }
  }
  return rows;
}

/**
 * Append one row to a JSONL state file (REQ-LED-1): one whole line in one O_APPEND write, never a truncate or rewrite,
 * so a concurrent writer's row is never lost.
 */
export function appendJsonl(file, row) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function appendAttempt(row) {
  // An attempt succeeds only when the worker finished and the gate passed (REQ-RUN-9); the report uses the same rule.
  const attemptPass = row.workerStatus === 'ok' && row.gatePass === true;
  appendJsonl(ledgerFile(), { ...row, attemptPass, usageMissing: row.usage === null, at: new Date().toISOString() });
}

export function readLedger() {
  return readJsonl(ledgerFile());
}

/**
 * Estimated spend for one repo on the UTC day of `now` (REQ-LINEAR-9). Rows with no cost (Codex reports
 * none) cannot be priced; they are counted separately so a ceiling is never silently weaker than it looks.
 */
export function spentToday(rows, repo, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  let usd = 0;
  let unpriced = 0;
  for (const r of rows) {
    if (r.repo !== repo || !String(r.at).startsWith(day)) continue;
    if (typeof r.cost === 'number') usd += r.cost;
    else unpriced += 1;
  }
  return { usd, unpriced };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const tierOf = (provider, model) => DEFAULTS.tiers.find((t) => t.provider === provider && t.model === model);
const tokensOf = (u) => (u ? u.in + (u.cacheWrite ?? 0) + u.out : 0);

/** An attempt's builder cost: recorded, else its usage at the default list price of its model (REQ-LED-12), else null. */
export const attemptCost = (r) => (typeof r.cost === 'number' ? r.cost : priceUsage(tierOf(r.provider, r.model), r.usage));

/** An attempt's review cost: recorded, else its review usage priced by the reviewer its row names (REQ-LED-13). */
export function reviewCostOf(r) {
  if (typeof r.reviewCost === 'number') return r.reviewCost;
  const [provider, model] = String(r.reviewer ?? '').split('/');
  return priceUsage(tierOf(provider, model), r.reviewUsage);
}

/**
 * Per-run summary (one run = one `keel run` of a card) plus the share of all runs passed on tier 0 (G2). Builder and
 * review spend are kept apart (REQ-LED-13); `cost` is their sum, as before.
 */
export function report(rows) {
  const cards = new Map();
  for (const r of rows) {
    // A refine turn (REQ-LED-17) and a propose turn (REQ-PROPOSE-4) are spend before a run, not a run.
    if (r.role === 'refine' || r.role === 'propose') continue;
    const c = cards.get(r.run) ?? {
      card: r.card,
      attempts: 0,
      passTier: null,
      tokens: 0,
      reviewTokens: 0,
      cached: 0,
      usageMissing: 0,
      durationMs: 0,
      cost: 0,
      builderCost: 0,
      reviewCost: 0,
      costMissing: 0,
      costMissingNoUsage: 0,
      reviewMissing: 0,
    };
    // Authoring (REQ-RUN-17) and a findings turn (REQ-RUN-38) are spend, not build attempts.
    if (r.role !== 'held-out-author' && r.role !== 'fix-findings') c.attempts += 1;
    c.durationMs += r.durationMs + (r.gateMs ?? 0);
    if (r.usage) {
      c.tokens += tokensOf(r.usage);
      c.cached += r.usage.cached;
    } else c.usageMissing += 1;
    const cost = attemptCost(r);
    if (cost === null) {
      c.costMissing += 1;
      if (!r.usage) c.costMissingNoUsage += 1; // a timeout before any result (REQ-LED-12)
    } else c.builderCost += cost;
    c.reviewTokens += tokensOf(r.reviewUsage);
    const reviewed = r.reviewer || r.reviewUsage || typeof r.reviewCost === 'number';
    const review = reviewed ? reviewCostOf(r) : null;
    if (review !== null) c.reviewCost += review; // Review is part of what the card cost (REQ-GATE-21).
    if (reviewed && (review === null || r.reviewUnpriced)) c.reviewMissing += 1; // unknown or a lower bound
    c.cost = c.builderCost + c.reviewCost;
    if (r.attemptPass) c.passTier = r.tier;
    cards.set(r.run, c);
  }
  const list = [...cards.values()];
  const passed = list.filter((c) => c.passTier !== null);
  const tier0 = passed.filter((c) => c.passTier === 0).length;
  // Denominator is every run, failed ones included, so parked cards cannot flatter the cheap-tier share.
  // Every run's spend counts, failed ones included: cost per accepted card is what a working card really cost (REQ-LED-4).
  const sum = (k) => list.reduce((n, c) => n + c[k], 0);
  const accepted = passed.length;
  const per = (n) => (accepted ? n / accepted : null);
  // What the corrective turns on review notes cost (REQ-RUN-38): the turn and its re-gate review.
  const turnReviewed = (r) => Boolean(r.reviewer || r.reviewUsage || typeof r.reviewCost === 'number');
  const turns = rows.filter((r) => r.role === 'fix-findings');
  const findingsTurns = turns.length
    ? {
        n: turns.length,
        fixed: turns.filter((r) => r.outcome === 'fixed').length,
        unchanged: turns.filter((r) => r.outcome === 'unchanged').length,
        reverted: turns.filter((r) => r.outcome === 'reverted').length,
        restoreFailed: turns.filter((r) => r.outcome === 'restore-failed').length,
        cost: turns.reduce((n, r) => n + (attemptCost(r) ?? 0) + (turnReviewed(r) ? (reviewCostOf(r) ?? 0) : 0), 0),
        // A turn whose builder or re-gate review cost is unknown or a lower bound makes the total a lower bound.
        unpriced: turns.filter((r) => attemptCost(r) === null || (turnReviewed(r) && (reviewCostOf(r) === null || r.reviewUnpriced)))
          .length,
      }
    : null;
  // What the refine turns before a build cost (REQ-LED-17), by answer.
  const refines = rows.filter((r) => r.role === 'refine');
  const refineTurns = refines.length
    ? {
        n: refines.length,
        ...Object.fromEntries(
          ['card', 'done', 'split', 'human', 'unparsed'].map((k) => [k, refines.filter((r) => r.outcome === k).length]),
        ),
        tokens: refines.reduce((n, r) => n + tokensOf(r.usage), 0),
        cost: refines.reduce((n, r) => n + (attemptCost(r) ?? 0), 0),
        unpriced: refines.filter((r) => attemptCost(r) === null).length,
      }
    : null;
  // What the propose turns cost (REQ-PROPOSE-4), and how many cards they drafted.
  const proposes = rows.filter((r) => r.role === 'propose');
  const proposeTurns = proposes.length
    ? {
        n: proposes.length,
        cards: proposes.reduce((n, r) => n + (r.proposed ?? 0), 0),
        cost: proposes.reduce((n, r) => n + (attemptCost(r) ?? 0), 0),
        unpriced: proposes.filter((r) => attemptCost(r) === null).length,
      }
    : null;
  const gateTimes = rows.filter((r) => typeof r.gateMs === 'number' && r.gateMs > 0).map((r) => r.gateMs);
  return {
    medianAcceptedMs: median(passed.map((c) => c.durationMs)),
    medianGateMs: median(gateTimes),
    cards: list,
    passed: passed.length,
    total: list.length,
    tier0Share: list.length ? tier0 / list.length : null,
    accepted,
    totalCost: sum('cost'),
    unpriced: sum('costMissing'),
    unpricedNoUsage: sum('costMissingNoUsage'),
    reviewUnpriced: sum('reviewMissing'),
    tokensPerAccepted: accepted ? Math.round(sum('tokens') / accepted) : null,
    reviewTokensPerAccepted: accepted ? Math.round(sum('reviewTokens') / accepted) : null,
    builderCostPerAccepted: per(sum('builderCost')),
    reviewCostPerAccepted: per(sum('reviewCost')),
    costPerAccepted: per(sum('cost')),
    findingsTurns,
    refineTurns,
    proposeTurns,
  };
}

const duration = (ms) => (ms === null ? 'n/a' : ms >= 90000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);

export function formatReport({
  cards,
  passed,
  total,
  tier0Share,
  accepted,
  unpriced,
  tokensPerAccepted,
  costPerAccepted,
  medianAcceptedMs,
  medianGateMs,
  findingsTurns = null,
  refineTurns = null,
  proposeTurns = null,
}) {
  const lines = cards.map(
    (c) =>
      `${c.card.padEnd(12)} attempts=${c.attempts} passTier=${c.passTier ?? 'FAIL'} tokens=${c.tokens} cached=${c.cached}` +
      `${c.usageMissing ? ` (usage missing on ${c.usageMissing})` : ''} time=${Math.round(c.durationMs / 1000)}s cost=${c.costMissing ? 'n/a' : `$${c.cost.toFixed(2)}`}`,
  );
  const share = tier0Share === null ? 'n/a' : `${Math.round(tier0Share * 100)}%`;
  const bound = unpriced ? '≥' : '';
  const perCard = costPerAccepted === null ? 'n/a' : `${bound}$${costPerAccepted.toFixed(2)}`;
  const note = unpriced ? ` (${unpriced} attempt${unpriced === 1 ? '' : 's'} unpriced)` : '';
  return [
    ...lines,
    `passed ${passed}/${total}; passed on tier 0: ${share}`,
    `accepted ${accepted}; tokens per accepted: ${tokensPerAccepted ?? 'n/a'}; cost per accepted: ${perCard}${note}`,
    `median time per accepted card: ${duration(medianAcceptedMs)}; median gate: ${duration(medianGateMs)}`,
    ...(findingsTurns
      ? [
          `findings turns: ${findingsTurns.n} (fixed ${findingsTurns.fixed}, unchanged ${findingsTurns.unchanged}, reverted ${findingsTurns.reverted}${findingsTurns.restoreFailed ? `, restore failed ${findingsTurns.restoreFailed}` : ''}); cost ${findingsTurns.unpriced ? '≥' : ''}$${findingsTurns.cost.toFixed(2)}`,
        ]
      : []),
    ...(refineTurns
      ? [
          `refine turns: ${refineTurns.n} (card ${refineTurns.card}, already done ${refineTurns.done}, split ${refineTurns.split}, needs human ${refineTurns.human}, unparsed ${refineTurns.unparsed}); tokens ${refineTurns.tokens}; cost ${refineTurns.unpriced ? '≥' : ''}$${refineTurns.cost.toFixed(2)}`,
        ]
      : []),
    ...(proposeTurns
      ? [
          `propose turns: ${proposeTurns.n}, ${proposeTurns.cards} cards drafted; cost ${proposeTurns.unpriced ? '≥' : ''}$${proposeTurns.cost.toFixed(2)}`,
        ]
      : []),
  ].join('\n');
}
