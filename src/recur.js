import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readReceipt } from './gate.js';

const DAY = 86400000;
/** A class recurs when it failed this many gates of at least two cards (REQ-LED-20). */
const MIN_GATES = 3;
const MIN_CARDS = 2;
const TOP = 10;
/** The window of `keel report --recur`, and the one before it for the trend. */
export const RECUR_DAYS = 14;

/** Every receipt in `dir`; a file that is not a receipt is skipped as the gate skips it (REQ-GATE-23). */
export function readReceipts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readReceipt(join(dir, f)))
    .filter(Boolean);
}

/**
 * The failure classes of one receipt: `<stage> <rule>` per rule of each failed stage, `<stage>` for a command stage
 * that only exited non-zero, and a review with no reviewer split by why each was out.
 */
function classes(r) {
  const out = new Set();
  for (const s of r.results) {
    if (!s || s.pass) continue;
    const rules = (s.problems ?? []).map((p) => p?.rule).filter(Boolean);
    if (!rules.length) out.add(s.name);
    for (const rule of rules) {
      const why = rule === 'review-unavailable' ? [...new Set((s.unavailable ?? []).map((u) => u.status))].sort().join('+') : '';
      out.add(why ? `${s.name} ${rule} ${why}` : `${s.name} ${rule}`);
    }
  }
  return out;
}

/**
 * Failure classes that recur across gates (REQ-LED-20): in the last `days`, at least 3 failed gates of at least 2
 * cards, most cards first. `before` counts the same class in the `days` before, so a prevention shows as a fall.
 */
export function recurring(receipts, { days = RECUR_DAYS, now = new Date() } = {}) {
  const end = now.getTime();
  const start = end - days * DAY;
  const tally = new Map();
  for (const r of receipts) {
    const at = Date.parse(r.at);
    if (r.pass || !(at > start - days * DAY && at <= end)) continue;
    const recent = at > start;
    for (const cls of classes(r)) {
      const t = tally.get(cls) ?? { cls, gates: 0, cards: new Set(), before: 0 };
      if (recent) {
        t.gates++;
        t.cards.add(r.card);
      } else t.before++;
      tally.set(cls, t);
    }
  }
  return [...tally.values()]
    .filter((t) => t.gates >= MIN_GATES && t.cards.size >= MIN_CARDS)
    .map((t) => ({ ...t, cards: t.cards.size }))
    .sort((a, b) => b.cards - a.cards || b.gates - a.gates || a.cls.localeCompare(b.cls))
    .slice(0, TOP);
}

export function formatRecurring(rows, days) {
  const head = `Recurring failures (last ${days} days)`;
  if (!rows.length) return `${head}: none recurred`;
  return [
    `${head}:`,
    ...rows.map((c) => `  ${c.cls}: ${c.gates} gates, ${c.cards} cards (previous ${days} days: ${c.before})`),
    'Prevent the top class at its source: file a Bug card with its Root cause and Prevention sections (cards skill) in the tool that owns it, then watch its count fall here.',
  ].join('\n');
}
