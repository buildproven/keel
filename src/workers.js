import { spawnSync } from 'node:child_process';
import { missingSignIn, workerEnv } from './env.js';

/** Build the provider command for one tier. `exec` runs any CLI; the prompt goes to its stdin. */
// The prompt goes on stdin: an argument has a size limit (cmux's claude wrapper: 120 KiB; Linux: 128 KiB) (REQ-RUN-31).
// `resume` continues that CLI session (REQ-RUN-33): the worker keeps what it already read instead of exploring again.
export function workerCommand(tier, prompt, config, resume = null) {
  const { provider, model, effort } = tier;
  const extra = config.workerArgs?.[provider] ?? [];
  if (provider === 'claude') {
    return {
      cmd: 'claude',
      args: [
        '-p',
        ...(resume ? ['--resume', resume] : []),
        '--output-format',
        'json',
        '--model',
        model,
        '--effort',
        effort,
        '--permission-mode',
        config.claudePermissionMode,
        ...extra,
      ],
      input: prompt,
    };
  }
  if (provider === 'codex' && resume) {
    // `codex exec resume` has no -s flag; the sandbox is set by config instead.
    const sandbox = ['-c', 'sandbox_mode="workspace-write"'];
    const args = ['exec', 'resume', '--json', '-m', model, '-c', `model_reasoning_effort=${effort}`, ...sandbox, ...extra, resume, '-'];
    return { cmd: 'codex', args, input: prompt };
  }
  if (provider === 'codex') {
    return {
      cmd: 'codex',
      args: ['exec', '--json', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-s', 'workspace-write', ...extra, '-'],
      input: prompt,
    };
  }
  if (provider === 'exec') {
    if (!Array.isArray(tier.command) || !tier.command.length) throw new Error('exec tier needs a "command" argv array');
    return { cmd: tier.command[0], args: [...tier.command.slice(1), ...extra], input: prompt };
  }
  throw new Error(`unknown provider "${provider}"`);
}

const parseLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null; // Non-JSON lines (banners, warnings) are expected in CLI output and are skipped.
  }
};

/**
 * Normalized usage (REQ-LED-1): `in` = uncached input, `cacheWrite` = Claude cache writes, present only when non-zero (billed above input), `cached` = cache reads, `out` = output.
 * Claude prints one JSON result object; exec workers may print the same shape.
 */
function parseResultJson(stdout) {
  const j = parseLine(stdout.trim().split('\n').at(-1) ?? '');
  if (!j) return { usage: null, cost: null, isError: false };
  const u = j.usage;
  const usage = u
    ? {
        in: u.input_tokens ?? 0,
        ...(u.cache_creation_input_tokens ? { cacheWrite: u.cache_creation_input_tokens } : {}),
        out: u.output_tokens ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
      }
    : null;
  // total_cost_usd is Claude's API-price estimate, not a subscription charge.
  return { usage, cost: j.total_cost_usd ?? null, isError: Boolean(j.is_error) };
}

/** Codex prints JSONL events; usage arrives on turn.completed, where input_tokens includes cached_input_tokens. */
function parseCodexEvents(stdout) {
  const usage = { in: 0, out: 0, cached: 0 };
  let seen = false;
  let isError = false;
  for (const e of stdout.split('\n').map(parseLine).filter(Boolean)) {
    if (e.type === 'turn.failed' || e.type === 'error') isError = true;
    if (e.type === 'turn.completed' && e.usage) {
      seen = true;
      const cached = e.usage.cached_input_tokens ?? 0;
      usage.in += (e.usage.input_tokens ?? 0) - cached;
      usage.out += e.usage.output_tokens ?? 0;
      usage.cached += cached;
    }
  }
  return { usage: seen ? usage : null, cost: null, isError };
}

/**
 * The model's final text (REQ-GATE-21): Claude's JSON `result`, Codex's last `agent_message`, else raw stdout (exec).
 */
export function resultText(provider, stdout) {
  const events = stdout.split('\n').map(parseLine).filter(Boolean);
  if (provider === 'claude') return events.findLast((e) => typeof e.result === 'string')?.result ?? stdout;
  if (provider === 'codex')
    return events.findLast((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item.text ?? stdout;
  return stdout;
}

/** The CLI session to continue (REQ-RUN-33): Codex's thread.started `thread_id`, else the last JSON `session_id`. */
export function sessionId(provider, stdout) {
  const events = stdout.split('\n').map(parseLine).filter(Boolean);
  if (provider === 'codex') return events.find((e) => e.type === 'thread.started' && typeof e.thread_id === 'string')?.thread_id ?? null;
  return events.findLast((e) => typeof e.session_id === 'string')?.session_id ?? null;
}

/** Two usages summed (REQ-LED-13): cache writes kept, since they are billed above input; null only when both are. */
export function addUsage(a, b) {
  if (!a || !b) return a ?? b ?? null;
  const cacheWrite = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  return { in: a.in + b.in, ...(cacheWrite ? { cacheWrite } : {}), out: a.out + b.out, cached: (a.cached ?? 0) + (b.cached ?? 0) };
}

/** Anthropic bills a 5-minute cache write at 1.25x the input price (REQ-LED-9). */
export const CACHE_WRITE_FACTOR = 1.25;

/**
 * What `usage` costs at `tier`'s list prices (REQ-LED-12), for a CLI that reports no cost (Codex). Null when the usage
 * is missing or the tier lacks a price the usage needs: an unknown price is never zero.
 */
export function priceUsage(tier, usage) {
  if (!usage || typeof tier?.priceInPerM !== 'number' || typeof tier.priceOutPerM !== 'number') return null;
  if (usage.cached && typeof tier.priceCachedPerM !== 'number') return null;
  const input = usage.in + (usage.cacheWrite ?? 0) * CACHE_WRITE_FACTOR;
  return (input * tier.priceInPerM + usage.out * tier.priceOutPerM + (usage.cached ?? 0) * (tier.priceCachedPerM ?? 0)) / 1e6;
}

export const parseUsage = (provider, stdout) => (provider === 'codex' ? parseCodexEvents(stdout) : parseResultJson(stdout));

// Node's own connection-error codes, plus phrases and explicit HTTP status names/codes that indicate a
// transient network or provider-service problem rather than the model failing at the task. A stronger
// model is no more likely to fix a dropped connection than a cheap one, so this must stay disjoint from
// 'error' (REQ-RUN-11): a bare number ("line 500") must never match, only an explicit status mention.
const NETWORK_CODES = /\bE(?:NOTFOUND|CONNREFUSED|CONNRESET|TIMEDOUT|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b/;
const NETWORK_PHRASES = /socket hang up|fetch failed|network (?:error|timeout)|connection (?:reset|refused|timed out)/i;
const NETWORK_STATUS =
  /\b(?:HTTP )?(?:50[0234])\b.{0,20}(?:error|gateway|unavailable|timeout)|(?:internal server error|bad gateway|service unavailable|gateway timeout)\s*\(?\b(?:50[0234])?\b\)?|status code 50[0234]\b/i;

// Provider limit and login failures, in the exact forms the claude and codex CLIs and their APIs print. Worker output
// also holds the model's and the tests' own text, and a test may say "rate limited", "usage limit", "expected status
// code 401" or "429 Too Many Requests" about the app under test, so a bare status number, a bare phrase, or a status
// after `status`/`Error` mid-line never counts: those failures escalate like any other (REQ-RUN-6, BUI-1191).
const QUOTA = new RegExp(
  [
    '^\\s*API Error:\\s*429\\b|^Error: 429 Too Many Requests\\s*$', // Claude CLI; a whole unindented line, never an app's `    Error: 429` stack
    'last status:?\\s*429\\b', // Codex: `exceeded retry limit, last status: 429 Too Many Requests`
    'hit your usage limit|usage limit reached|\\b(?:5-hour|weekly|daily|session) limit reached',
    'rate_limit_error|rate_limit_exceeded|insufficient_quota|resource_exhausted', // API error codes
    'exceeded your current quota|quota exceeded\\. check your plan|rate limit reached for \\S+ in organization',
  ].join('|'),
  'im',
);
const AUTH = new RegExp(
  [
    '^\\s*API Error:\\s*401\\b', // Claude CLI: `API Error: 401 {…}`; an app's `Error: 401 Unauthorized` is not
    'unexpected status 401 unauthori[sz]ed', // Codex
    'not logged in\\W+please (?:run /login|log ?in)|invalid api key\\W+please run /login|invalid_api_key',
    'oauth token has expired',
  ].join('|'),
  'im',
);

/** Failure class decides the next step (REQ-RUN-6, REQ-RUN-11): quota → other provider, auth → stop,
 * network → retry the same tier, else escalate. */
export function classifyFailure(output) {
  if (QUOTA.test(output)) return 'quota';
  if (AUTH.test(output)) return 'auth';
  if (NETWORK_CODES.test(output) || NETWORK_PHRASES.test(output) || NETWORK_STATUS.test(output)) return 'network';
  return 'error';
}

/**
 * Run one worker attempt in cwd. Exec workers get the tier's model and effort as KEEL_MODEL / KEEL_EFFORT, and the
 * session to continue as KEEL_RESUME (REQ-RUN-33).
 */
export function runWorker(tier, prompt, cwd, config, resume = null) {
  const { cmd, args, input } = workerCommand(tier, prompt, config, resume);
  const env = {
    ...workerEnv(tier.provider, process.env, config.workerEnvAllow), // REQ-RUN-12, REQ-RUN-50: its own sign-in only
    KEEL_MODEL: tier.model ?? '',
    KEEL_EFFORT: tier.effort ?? '',
  };
  delete env.KEEL_RESUME; // only Keel decides what a worker continues; an inherited value would resume a stranger's session
  if (resume && tier.provider === 'exec') env.KEEL_RESUME = resume;
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: config.workerTimeoutSec * 1000,
  });
  const parsed = parseUsage(tier.provider, r.stdout ?? '');
  let output = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000);
  let status = 'ok';
  if (r.error?.code === 'ETIMEDOUT') status = 'timeout';
  // An early exit before the prompt is read gives EPIPE on stdin; the exit and output still classify it (REQ-RUN-29).
  else if (r.error && !(r.error.code === 'EPIPE' && r.status !== null)) status = `spawn-error: ${r.error.message}`;
  else if (r.status !== 0 || parsed.isError) status = classifyFailure(output);
  // REQ-RUN-50: every caller (builder, held-out author, reviewer) reports the sign-in fix with the failure.
  const fix = status === 'auth' ? missingSignIn(tier.provider, process.env) : null;
  if (fix) output = `${output.trimEnd()}\nfix: ${fix}`;
  const text = resultText(tier.provider, r.stdout ?? '').slice(-100000);
  const session = sessionId(tier.provider, r.stdout ?? '');
  const cost = parsed.cost ?? priceUsage(tier, parsed.usage); // REQ-LED-12: Codex prints usage but no cost
  return { status, usage: parsed.usage, cost, durationMs: Date.now() - started, output, text, session };
}
