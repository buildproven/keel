import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { workerEnv } from './env.js';

/**
 * Subscription plan windows (REQ-PLAN-1). A Claude or Codex subscription is not billed per token: the ceiling that
 * matters is the share of the plan's 5-hour and weekly windows already used, shared with the owner's own sessions.
 * Each window is `{ used: percent 0..100, resetsAt: epoch seconds }`; a window past its reset reads 0.
 */
const parseLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null; // Non-JSON lines are expected in CLI output and session logs, and are skipped.
  }
};

const window = (used, resetsAt, now) =>
  typeof used === 'number' ? { used: typeof resetsAt === 'number' && resetsAt <= now ? 0 : used, resetsAt } : null;

/** The last `rate_limit_event` of `claude -p --output-format stream-json --verbose`; null without one (API key). */
export function claudeWindows(stdout, now = Date.now() / 1000) {
  const e = stdout
    .split('\n')
    .map(parseLine)
    .findLast((x) => x?.type === 'rate_limit_event' && x.rate_limit_info?.unifiedWindows);
  if (!e) return null;
  const w = e.rate_limit_info.unifiedWindows;
  const pct = (x) => (typeof x?.utilization === 'number' ? Math.round(x.utilization * 1000) / 10 : undefined);
  return { fiveHour: window(pct(w.five_hour), w.five_hour?.resetsAt, now), week: window(pct(w.seven_day), w.seven_day?.resetsAt, now) };
}

/** The last `rate_limits` of a Codex session log: `primary` is the 5-hour window, `secondary` the weekly one. */
export function codexWindows(text, now = Date.now() / 1000) {
  const r = text
    .split('\n')
    .filter((l) => l.includes('"rate_limits"'))
    .map(parseLine)
    .map((e) => e?.payload?.rate_limits ?? e?.rate_limits)
    .findLast((x) => x?.primary || x?.secondary);
  if (!r) return null;
  return {
    fiveHour: window(r.primary?.used_percent, r.primary?.resets_at, now),
    week: window(r.secondary?.used_percent, r.secondary?.resets_at, now),
  };
}

const TAIL_BYTES = 512 * 1024;

/** The end of a file: a session log can be large, and only its last rate_limits line counts. */
function tail(file) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The newest Codex session log: `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, newest day first, then newest file. */
function newestCodexLog(home) {
  let dir = join(home, 'sessions');
  for (let depth = 0; depth < 3; depth++) {
    if (!existsSync(dir)) return null;
    const sub = readdirSync(dir)
      .filter((d) => /^\d+$/.test(d))
      .sort()
      .at(-1);
    if (!sub) return null;
    dir = join(dir, sub);
  }
  const logs = readdirSync(dir)
    .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
    .map((f) => join(dir, f));
  return logs.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1) ?? null;
}

/** A one-line Claude call whose stream carries the plan windows; it costs a few cents of window at most. */
function probeClaude(tier, config) {
  const r = spawnSync(
    'claude',
    ['-p', '--output-format', 'stream-json', '--verbose', '--model', tier.model, '--effort', 'low', ...(config.workerArgs?.claude ?? [])],
    {
      input: 'Reply with the word ok.',
      env: workerEnv('claude', process.env, config.workerEnvAllow), // REQ-RUN-50: the probe is the Claude CLI
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return r.stdout ?? '';
}

/**
 * Plan windows of each provider of the tier ladder (REQ-PLAN-1): `{ claude, codex }`, each windows or null when
 * unknown. Claude: a probe call. Codex: the newest session log of any Codex session on this machine, so the owner's
 * own sessions count too.
 */
export function readPlan(
  config,
  { now = Date.now() / 1000, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), claudeProbe = probeClaude } = {},
) {
  const plan = {};
  const claude = config.tiers.find((t) => t.provider === 'claude');
  if (claude) plan.claude = claudeWindows(claudeProbe(claude, config), now);
  if (config.tiers.some((t) => t.provider === 'codex')) {
    const log = newestCodexLog(codexHome);
    plan.codex = log ? codexWindows(tail(log), now) : null;
  }
  return plan;
}

const NAMES = { fiveHour: '5h', week: 'week' };

/** Providers with a window at or over its `planLimits` percent, each with why (REQ-PLAN-2); an unknown window never counts. */
export function reservedProviders(plan, limits) {
  const out = new Map();
  for (const [provider, w] of Object.entries(plan)) {
    const over = Object.keys(NAMES)
      .filter((k) => typeof w?.[k]?.used === 'number' && w[k].used >= limits[k])
      .map((k) => `${NAMES[k]} ${w[k].used}% ≥ ${limits[k]}%`);
    if (over.length) out.set(provider, over.join(', '));
  }
  return out;
}

/** `claude 5h 4% · week 34%; codex unknown` */
export function planLine(plan) {
  return Object.entries(plan)
    .map(([provider, w]) => {
      const parts = Object.entries(NAMES)
        .filter(([k]) => w?.[k])
        .map(([k, n]) => `${n} ${w[k].used}%`);
      return `${provider} ${parts.length ? parts.join(' · ') : 'unknown'}`;
    })
    .join('; ');
}

/** The earliest reset among the windows that reserve a provider, as local time, or null. */
export function nextReset(plan, limits) {
  const at = Object.values(plan)
    .flatMap((w) =>
      Object.keys(NAMES)
        .filter((k) => typeof w?.[k]?.used === 'number' && w[k].used >= limits[k])
        .map((k) => w[k].resetsAt),
    )
    .filter((s) => typeof s === 'number')
    .sort((a, b) => a - b)[0];
  return at ? new Date(at * 1000).toString().slice(0, 21) : null;
}

/** A plan reading this old or older is not used by the review window (REQ-PLAN-5): windows move as sessions work. */
export const PLAN_MAX_AGE_MS = 30 * 60 * 1000;

const planFile = (dir) => join(dir, 'plan.json');

/** Keep a plan reading with its time in the state dir, so every gate and poll of the machine shares it (REQ-PLAN-5). */
export function savePlan(plan, dir, now = new Date()) {
  const file = planFile(dir);
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const [family, w] of Object.entries(plan)) all[family] = w ? { ...w, at: now.toISOString() } : null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 1)}\n`);
}

/** A family's saved plan windows when the reading is fresh, a window past its reset reading 0; else null. */
export function cachedPlan(dir, family, now = new Date()) {
  const file = planFile(dir);
  const w = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))[family] : null;
  if (!w?.at || now.getTime() - Date.parse(w.at) >= PLAN_MAX_AGE_MS) return null;
  const s = now.getTime() / 1000;
  const fresh = (x) => (x ? { used: typeof x.resetsAt === 'number' && x.resetsAt <= s ? 0 : x.used, resetsAt: x.resetsAt } : null);
  return { fiveHour: fresh(w.fiveHour), week: fresh(w.week) };
}
