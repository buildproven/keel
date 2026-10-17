import { escapedDefects } from './escaped.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * DORA metrics for Keel changes, per repo, from git and the ledger only (REQ-LED-7): merges per week, median lead
 * time (first attempt start to merge), change failure rate (merges later fixed or reverted, REQ-LED-6), and median
 * time to restore (merge to the first fix or revert). Only merges inside the window count.
 */
export function dora(rows, { now = new Date(), windowDays = 30 } = {}) {
  const startOf = new Map();
  for (const r of rows) {
    const start = Date.parse(r.at) - (r.durationMs ?? 0) - (r.gateMs ?? 0);
    if (!startOf.has(r.run) || start < startOf.get(r.run)) startOf.set(r.run, start);
  }
  const { merged } = escapedDefects(rows);
  const from = now.getTime() - windowDays * DAY_MS;
  const repos = [...new Set(rows.filter((r) => r.attemptPass && typeof r.repo === 'string').map((r) => r.repo))];
  return repos.map((repo) => {
    const inWindow = merged.filter((m) => m.repo === repo && Date.parse(m.mergedAt) >= from && Date.parse(m.mergedAt) <= now.getTime());
    const failures = inWindow
      .map((m) => {
        const first = Math.min(...[...m.candidates, ...m.reverts].map((c) => Date.parse(c.at)));
        return Number.isFinite(first) ? { card: m.card, restoreMs: first - Date.parse(m.mergedAt) } : null;
      })
      .filter(Boolean);
    return {
      repo,
      windowDays,
      merged: inWindow.length,
      perWeek: inWindow.length / (windowDays / 7),
      leadTimeMs: median(inWindow.map((m) => Date.parse(m.mergedAt) - startOf.get(m.run))),
      failures,
      failureRate: inWindow.length ? failures.length / inWindow.length : null,
      restoreMs: median(failures.map((f) => f.restoreMs)),
    };
  });
}

const span = (ms) => {
  if (ms === null) return 'n/a';
  if (ms < HOUR_MS) return `${Math.round(ms / 60000)}m`;
  if (ms < DAY_MS) return `${Number((ms / HOUR_MS).toFixed(1))}h`;
  return `${Number((ms / DAY_MS).toFixed(1))}d`;
};

export function formatDora(repos) {
  return repos
    .map((r) =>
      r.merged === 0
        ? `${r.repo}: no Keel change merged in the last ${r.windowDays} days`
        : `${r.repo}: merged ${r.merged} (${r.perWeek.toFixed(1)}/week); lead time ${span(r.leadTimeMs)}; ` +
          `change failure rate ${Math.round(r.failureRate * 100)}% (${r.failures.length}/${r.merged}); time to restore ${span(r.restoreMs)}`,
    )
    .join('\n');
}
