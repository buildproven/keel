import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment hygiene for model processes and repo checks (REQ-RUN-12).
 *
 * A worker is a model with shell access: whatever is in its environment is in its reach. The operator's
 * shell legitimately holds API keys (for `keel poll` itself), so anything secret-looking is dropped
 * before a worker or a configured check starts, unless `keel.json` allowlists the exact name.
 */
const SECRET_WORD = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD)(_|$)/i;

export function scrubEnv(env, allow = []) {
  const keep = new Set(allow);
  return Object.fromEntries(Object.entries(env).filter(([name]) => keep.has(name) || !SECRET_WORD.test(name)));
}

let emptyGhDir = null;
const madeGhDirs = [];
let cleanupHooksInstalled = false;
const removeGhDirs = () => {
  for (const dir of madeGhDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // REQ-RUN-40: candidate code can make its temporary config unremovable; cleanup must not change how Keel exits.
      const reason = error instanceof Error ? (error.code ?? error.message) : String(error);
      console.error(`keel: WARN could not remove temporary GH_CONFIG_DIR ${dir}: ${reason}`);
    }
  }
  madeGhDirs.length = 0;
  emptyGhDir = null;
};

/**
 * On SIGINT or SIGTERM, remove the dirs, then end as the signal would have (REQ-RUN-47). Our only listener removes
 * itself and raises the signal again; when another listener owns the signal, it decides whether the process continues.
 */
function onSignal(signal) {
  removeGhDirs();
  if (process.listenerCount(signal) === 1) {
    process.off(signal, onSignal);
    process.kill(process.pid, signal);
  }
}

/**
 * An empty dir for GH_CONFIG_DIR; a new one if candidate code wrote into the last one. A replaced dir is kept until
 * exit, since a candidate process started with it may still run; the 'exit' hook removes every dir made (REQ-RUN-40),
 * and so does a SIGINT or SIGTERM that ends the process (REQ-RUN-47).
 */
function noGhConfig() {
  if (!emptyGhDir || readdirSync(emptyGhDir).length) {
    if (!cleanupHooksInstalled) {
      cleanupHooksInstalled = true;
      process.on('exit', removeGhDirs);
      for (const signal of ['SIGINT', 'SIGTERM']) process.prependListener(signal, onSignal);
    }
    emptyGhDir = mkdtempSync(join(tmpdir(), 'keel-nogh-'));
    madeGhDirs.push(emptyGhDir);
  }
  return emptyGhDir;
}

/**
 * The environment of candidate code: workers and every check, test, held-out, and mutation run (REQ-RUN-12). On top of
 * scrubEnv, it hides the owner's GitHub credentials, which live in files, not variables: an empty GH_CONFIG_DIR (gh,
 * and git's `gh auth git-credential` helper, find no login), no system git config (macOS keychain helper), no ssh agent,
 * and no credential prompts. Otherwise candidate code could post the keel/gate status itself (BUI-1151). Names in
 * `allow` keep their real value.
 */
export function candidateEnv(env, allow = []) {
  const out = scrubEnv(env, allow);
  const keep = new Set(allow);
  if (!keep.has('GH_CONFIG_DIR')) out.GH_CONFIG_DIR = noGhConfig();
  if (!keep.has('SSH_AUTH_SOCK')) delete out.SSH_AUTH_SOCK;
  out.GIT_CONFIG_NOSYSTEM = '1';
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

/**
 * The names std-env (vitest's reporter choice) reads as a coding agent (REQ-GATE-51). Names only: std-env also matches
 * patterns in PATH, EDITOR, and TERM_PROGRAM, which a command needs and Claude Code and Codex do not set that way.
 */
export const AGENT_ENV = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'REPL_ID',
  'GEMINI_CLI',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'OPENCODE',
  'AUGMENT_AGENT',
  'GOOSE_PROVIDER',
  'JUNIE_DATA',
  'JUNIE_SHIM_PATH',
  'CURSOR_AGENT',
];

/**
 * The environment of a gate check, test, held-out, install, or mutation command (REQ-GATE-51): the candidate
 * environment without the coding-agent variables, so a runner prints the same output whichever program started the
 * gate. Workers keep them (they are the agent). Names in `allow` keep their real value.
 */
export function checkEnv(env, allow = []) {
  const out = candidateEnv(env, allow);
  for (const name of AGENT_ENV) if (!allow.includes(name)) delete out[name];
  return out;
}
