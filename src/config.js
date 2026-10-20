import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { showFile } from './git.js';

export const KINDS = ['bug', 'feature', 'refactor', 'ui', 'infra', 'chore'];
const SIZES = ['S', 'M', 'L'];
const FIELDS = ['kind', 'size', 'paths', 'heldOut', 'allowEdits', 'acceptance'];
const NAME = /^[A-Za-z0-9_-]+$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const table = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PROVIDERS = ['claude', 'codex', 'exec'];

/** Review finding severities, most severe first (REQ-GATE-21). */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];

export const DEFAULTS = {
  // No default checks/testCommand (REQ-CFG-1): the gate is language-free (REQ-PROJ-1) and must not
  // guess a project's toolchain. Run `keel init` to propose them, or set them in keel.json yourself.
  checks: null,
  testCommand: null,
  // The test command for given files, `{files}` standing for them (REQ-GATE-33); null runs the whole suite.
  testFilesCommand: null,
  heldOutCommand: null,
  // Test-file globs across common languages (REQ-PROJ-3): JS/TS, Python, Go, Rust, Ruby, Java/Kotlin, C#, PHP.
  testGlobs: [
    'test/**',
    'tests/**',
    'spec/**',
    '**/__tests__/**',
    '**/*.test.*',
    '**/*.spec.*',
    '**/*_test.go',
    '**/*_test.py',
    '**/test_*.py',
    '**/*_spec.rb',
    '**/*Test.java',
    '**/*Tests.java',
    '**/*Test.kt',
    '**/*Test.cs',
  ],
  // Files that define what "passing" means. Changing one needs `allowEdits` in the card (REQ-GATE-4).
  // pyproject.toml is handled separately (REQ-PROJ-4): only its tool sections are locked, so dependency
  // edits stay free — see the pyprojectToolSectionsChanged check in gate.js.
  verificationPaths: [
    'keel.json',
    '**/.gitattributes',
    '.github/**',
    '**/vitest.config.*',
    '**/jest.config.*',
    '**/playwright.config.*',
    '**/.mocharc*',
    '**/pytest.ini',
    '**/.pytest.ini',
    '**/conftest.py',
    '**/tox.ini',
    '**/setup.cfg',
    '**/tsconfig*.json',
    '**/eslint.config.*',
    '**/.eslintrc*',
    '**/.eslintignore',
    '**/.prettierrc*',
    '**/.prettierignore',
    '**/prettier.config.*',
    '**/vite.config.*',
    '**/vitest.workspace.*',
    '**/.npmrc',
    '**/.yarnrc*',
    '**/Makefile',
    '**/makefile',
    '**/GNUmakefile',
    '**/justfile',
    '**/Taskfile.*',
    '**/taskfile.*',
    '**/noxfile.py',
    '**/ruff.toml',
    '**/.ruff.toml',
    '**/mypy.ini',
    '**/.golangci.*',
    '**/rubocop.yml',
    '**/.rubocop.yml',
    '**/.rspec',
    '**/*.csproj',
    '**/phpunit.xml*',
    '**/*.tf',
    '**/*.tfvars',
  ],
  protected: ['.github/**', '**/auth/**', '**/payments/**', '**/migrations/**', 'infra/**', '**/*.tf', '**/.env*'],
  bypassAllow: [],
  heldOutRequired: ['M', 'L'],
  // Tier that writes held-out tests for a card that needs them and names none (REQ-RUN-17); best a different provider.
  heldOutAuthorTier: null,
  shareDirs: ['node_modules', '.venv'],
  workerEnvAllow: [],
  acceptance: {},
  install: null,
  // Optional mutation-test command, run on the changed source files of bug/feature cards (REQ-GATE-20).
  mutation: null,
  // Cross-model review stage, on by default (REQ-GATE-21): it finds what tests miss.
  review: true,
  // Lowest finding severity that blocks (REQ-GATE-21).
  reviewBlock: 'medium',
  reviewFallback: true,
  // One corrective turn on non-blocking review notes before a bug or feature card is accepted (REQ-RUN-36).
  fixLowFindings: true,
  approveAllowEdits: true, // the other family may approve a builder's allowEdits request on test files (REQ-RUN-30) // another family reviews when the reviewer is out (REQ-GATE-22)
  // Token budget per provider family and window length in hours; a nearly used window goes to the fallback (REQ-GATE-24).
  reviewWindows: {},
  // A re-gate of a small doc-only change runs the reviewer at this effort; null turns it off (REQ-GATE-25).
  lightReview: { maxLines: 20, effort: 'low' },
  // Production smoke command run by the post-deploy workflow with KEEL_DEPLOY_URL (REQ-PROJ-7).
  smoke: null,
  linearProject: null,
  // Estimated list-price dollars: a ceiling for API-key billing, not for a subscription (REQ-LINEAR-9).
  dailyBudgetUsd: null,
  // Plan window percents at which `keel poll` stops using a subscription provider; null turns it off (REQ-PLAN-2).
  planLimits: { fiveHour: 90, week: 80 },
  // Found-work issues `keel poll` may file per repo per UTC day (REQ-LINEAR-22); 0 turns filing off.
  followUpsPerDay: 5,
  // One read-only refine turn before `keel poll` builds an unclear or too-big issue (REQ-LINEAR-32).
  refineIssues: true,
  // How long `keel poll --merge` waits for every check on a certified SHA before it gives up a self-merge (REQ-MERGE-4).
  selfMergeTimeoutMinutes: 30,
  // Stop a card once its priced cost reaches this many dollars (REQ-RUN-22); default none.
  cardBudgetUsd: null,
  // Start one tier up when the ledger shows the cheap first try does not pay (REQ-RUN-21).
  learnStart: true,
  // Days a parked worktree with only Keel's own commits is kept after its card's last activity (REQ-CLEAN-3).
  worktreeKeepDays: 7,
  // No low-effort Sonnet tier (REQ-RUN-35): it cost what Sonnet high costs per attempt and passed first less often.
  // List prices in USD per million tokens (REQ-LED-12), read 2026-10-14 from
  // https://platform.claude.com/docs/en/about-claude/pricing (Opus 5.5 $4 in / $0.20 cache hit / $20 out;
  // Sonnet 5.5 $2 / $0.10 / $10) and https://developers.openai.com/api/docs/pricing (gpt-5.6-sol standard, up to 272K
  // input: $4 / $0.40 cached / $20; promotional price to at least 2026-11-21). They price usage only where the CLI
  // reports no cost (Codex); Claude's own total_cost_usd wins.
  tiers: [
    { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', priceInPerM: 2, priceCachedPerM: 0.1, priceOutPerM: 10 },
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', priceInPerM: 4, priceCachedPerM: 0.2, priceOutPerM: 20 },
    { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', priceInPerM: 4, priceCachedPerM: 0.4, priceOutPerM: 20 },
  ],
  startTier: { L: 1, protected: 0 },
  maxAttempts: 4,
  workerTimeoutSec: 1800,
  failureTailChars: 4000,
  claudePermissionMode: 'auto',
  // Trim worker context: no MCP servers, no skill listing (REQ-RUN-8).
  workerArgs: { claude: ['--strict-mcp-config', '--disable-slash-commands'], codex: [] },
};

/** Shared dependency dirs to symlink into checkouts; none when `install` builds each checkout itself (REQ-GATE-16). */
export const linkedDirs = (config) => (config.install ? [] : config.shareDirs);

function validate(c) {
  const bad = (msg) => {
    throw new Error(`keel.json: ${msg}`);
  };
  if (!c.checks || !c.testCommand)
    bad('"checks" and "testCommand" are not set. Run `keel init` to detect the project, or set them yourself in keel.json.');
  if (!table(c.checks)) bad('"checks" must be a table of name to command');
  const values = Object.values(c.checks);
  if (!values.length || !values.every((v) => typeof v === 'string' && v)) bad('"checks" needs at least one non-empty command');
  if (typeof c.testCommand !== 'string' || !c.testCommand) bad('"testCommand" must be a non-empty command');
  if (typeof c.heldOutCommand !== 'string' || !c.heldOutCommand) bad('"heldOutCommand" must be a non-empty command');
  if (c.testFilesCommand !== null && !(typeof c.testFilesCommand === 'string' && c.testFilesCommand.includes('{files}')))
    bad('"testFilesCommand" must be null or a command with a {files} placeholder');
  const tierOk = (t) =>
    PROVIDERS.includes(t?.provider) &&
    (t.provider === 'exec' ? Array.isArray(t.command) : typeof t.model === 'string' && typeof t.effort === 'string');
  if (!Array.isArray(c.tiers) || !c.tiers.length || !c.tiers.every(tierOk)) bad('"tiers" needs ≥ 1 tier with a provider');
  if (!Number.isInteger(c.maxAttempts) || c.maxAttempts < 1) bad('"maxAttempts" must be an integer ≥ 1');
  if (
    c.heldOutAuthorTier !== null &&
    !(Number.isInteger(c.heldOutAuthorTier) && c.heldOutAuthorTier >= 0 && c.heldOutAuthorTier < c.tiers.length)
  )
    bad('"heldOutAuthorTier" must be a tier index');
  for (const t of c.tiers)
    for (const k of ['priceInPerM', 'priceOutPerM', 'priceCachedPerM'])
      if (t[k] !== undefined && !(typeof t[k] === 'number' && t[k] >= 0)) bad(`tier ${k} must be a non-negative number`);
  if (!table(c.startTier)) bad('"startTier" must be a table of L and protected to a tier index');
  const extraStart = Object.keys(c.startTier).filter((k) => !own(DEFAULTS.startTier, k));
  if (extraStart.length) bad(`startTier: unknown keys: ${extraStart.join(', ')}`);
  for (const [k, v] of Object.entries(c.startTier))
    if (!Number.isInteger(v) || v < 0 || v >= c.tiers.length) bad(`startTier.${k} is not a tier index`);
  for (const k of ['testGlobs', 'verificationPaths', 'heldOutRequired', 'protected', 'bypassAllow', 'shareDirs', 'workerEnvAllow'])
    if (!Array.isArray(c[k]) || !c[k].every((v) => typeof v === 'string')) bad(`"${k}" must be an array of strings`);
  if (!c.heldOutRequired.every((v) => SIZES.includes(v))) bad('"heldOutRequired" entries must be S, M, or L');
  if (!Number.isInteger(c.workerTimeoutSec) || c.workerTimeoutSec < 1) bad('"workerTimeoutSec" must be an integer ≥ 1');
  if (!Number.isInteger(c.failureTailChars) || c.failureTailChars < 0) bad('"failureTailChars" must be an integer ≥ 0');
  if (!table(c.workerArgs) || !Object.values(c.workerArgs).every((a) => Array.isArray(a) && a.every((v) => typeof v === 'string')))
    bad('"workerArgs" must be a table of provider to an array of strings');
  if (typeof c.claudePermissionMode !== 'string' || !c.claudePermissionMode) bad('"claudePermissionMode" must be a non-empty string');
  if (c.install !== null && !(typeof c.install === 'string' && c.install.trim())) bad('"install" must be a non-empty command string');
  if (c.smoke !== null && !(typeof c.smoke === 'string' && c.smoke.trim())) bad('"smoke" must be a non-empty command string');
  if (typeof c.review !== 'boolean') bad('"review" must be true or false');
  if (typeof c.fixLowFindings !== 'boolean') bad('"fixLowFindings" must be true or false');
  if (typeof c.approveAllowEdits !== 'boolean') bad('"approveAllowEdits" must be true or false');
  if (typeof c.reviewFallback !== 'boolean') bad('"reviewFallback" must be true or false');
  const windows = c.reviewWindows;
  const positive = (n) => typeof n === 'number' && n > 0;
  if (!windows || typeof windows !== 'object' || Array.isArray(windows))
    bad('"reviewWindows" must be a table of family to { hours, tokens }');
  for (const [family, w] of Object.entries(windows))
    if (!positive(w?.hours) || !positive(w?.tokens)) bad(`reviewWindows "${family}" needs positive numbers "hours" and "tokens"`);
  const light = c.lightReview;
  if (light !== null && !(Number.isInteger(light?.maxLines) && light.maxLines >= 0 && typeof light.effort === 'string' && light.effort))
    bad('"lightReview" must be null or { maxLines: integer ≥ 0, effort: string }');
  if (!SEVERITIES.includes(c.reviewBlock)) bad(`"reviewBlock" must be one of ${SEVERITIES.join(', ')}`);
  if (typeof c.refineIssues !== 'boolean') bad('"refineIssues" must be true or false');
  if (typeof c.learnStart !== 'boolean') bad('"learnStart" must be true or false');
  if (c.cardBudgetUsd !== null && !(typeof c.cardBudgetUsd === 'number' && c.cardBudgetUsd > 0))
    bad('"cardBudgetUsd" must be a positive number');
  if (c.mutation !== null && !(typeof c.mutation === 'string' && c.mutation.trim())) bad('"mutation" must be a non-empty command string');
  const acc = c.acceptance;
  if (!acc || typeof acc !== 'object' || Array.isArray(acc)) bad('"acceptance" must be a table of name to command');
  for (const [name, cmd] of Object.entries(acc))
    if (!NAME.test(name) || typeof cmd !== 'string' || !cmd.trim())
      bad(`acceptance "${name}" needs a plain name and a non-empty command string`);
  if (c.linearProject !== null && !(typeof c.linearProject === 'string' && c.linearProject.trim()))
    bad('"linearProject" must be a non-empty string');
  if (c.dailyBudgetUsd !== null && !(typeof c.dailyBudgetUsd === 'number' && c.dailyBudgetUsd > 0))
    bad('"dailyBudgetUsd" must be a positive number');
  const pl = c.planLimits;
  const pct = (n) => typeof n === 'number' && n > 0 && n <= 100;
  if (pl !== null && !(table(pl) && Object.keys(pl).sort().join() === 'fiveHour,week' && pct(pl.fiveHour) && pct(pl.week)))
    bad('"planLimits" must be null or { fiveHour, week }, each a percent above 0 and at most 100');
  if (!Number.isInteger(c.followUpsPerDay) || c.followUpsPerDay < 0) bad('"followUpsPerDay" must be an integer ≥ 0');
  if (!Number.isInteger(c.worktreeKeepDays) || c.worktreeKeepDays < 0) bad('"worktreeKeepDays" must be an integer ≥ 0');
  if (!positive(c.selfMergeTimeoutMinutes)) bad('"selfMergeTimeoutMinutes" must be a positive number');
  for (const d of c.shareDirs) if (d.includes('..') || d.startsWith('/')) bad(`shareDirs entry "${d}" must be a plain relative name`);
  return c;
}

/** The length of the default ladder before REQ-RUN-35 cut it (REQ-RUN-39). */
const LEGACY_DEFAULT_TIERS = 4;

/**
 * Config comes from keel.json at a git ref — for the gate, the base commit — so the change under test
 * cannot rewrite its own rules (REQ-CFG-1).
 */
export function loadConfig(repo, ref) {
  const text = showFile(ref, 'keel.json', repo);
  const user = text === null ? {} : JSON.parse(text);
  const unknown = Object.keys(user).filter((k) => !own(DEFAULTS, k));
  if (unknown.length) throw new Error(`keel.json: unknown keys: ${unknown.join(', ')}`);
  const config = { ...structuredClone(DEFAULTS), ...user };
  if (config.testCommand && !own(user, 'heldOutCommand')) config.heldOutCommand = config.testCommand;
  // shareDirs written in keel.json are dirs the checks need; the defaults are only linked when present (REQ-GATE-49).
  config.shareDirsRequired = own(user, 'shareDirs');
  if (table(config.startTier)) {
    // startTier merges over the default floors, so a partial table keeps the others (REQ-CFG-1). Default floors follow
    // the configured ladder; floors written in keel.json are validated as written.
    const written = own(user, 'startTier') ? user.startTier : {};
    config.startTier = { ...structuredClone(DEFAULTS.startTier), ...written };
    if (Array.isArray(config.tiers) && config.tiers.length)
      for (const k of Object.keys(DEFAULTS.startTier))
        if (!own(written, k)) config.startTier[k] = Math.min(config.startTier[k], config.tiers.length - 1);
  }
  // An index past the default ladder but inside the four-tier one before REQ-RUN-35 was written for that one: it named the other family's top tier then,
  // so it gets the REQ-RUN-28 default, loudly (REQ-RUN-39). Past tiers keel.json sets itself, it stays an error.
  const legacy =
    own(user, 'heldOutAuthorTier') &&
    !own(user, 'tiers') &&
    Number.isInteger(user.heldOutAuthorTier) &&
    Array.isArray(config.tiers) &&
    user.heldOutAuthorTier >= config.tiers.length &&
    user.heldOutAuthorTier < LEGACY_DEFAULT_TIERS;
  if (legacy)
    process.stderr.write(
      `keel: WARN keel.json heldOutAuthorTier ${user.heldOutAuthorTier} is past the default tiers (${config.tiers.length}); using the strongest tier of the other family. Remove the line.\n`,
    );
  if ((legacy || !own(user, 'heldOutAuthorTier')) && Array.isArray(config.tiers) && config.tiers.length) {
    // Held-out tests from the other family by default, so M/L cards need no human (REQ-RUN-28); null opts out.
    const family = (t) => t?.family ?? t?.provider;
    const other = config.tiers.findLastIndex((t) => family(t) !== family(config.tiers[0]));
    config.heldOutAuthorTier = other === -1 ? null : other;
  }
  return validate(config);
}

const list = (v) =>
  v
    ? v
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

/** Parse a card: `key: value` header lines before the first `## ` heading; the whole file is the task text. */
export function parseCard(text, file = 'card.md') {
  const fields = {};
  for (const line of text.split(/^## /m)[0].split('\n')) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (!FIELDS.includes(m[1])) throw new Error(`card: unknown header "${m[1]}" (allowed: ${FIELDS.join(', ')})`);
    if (own(fields, m[1])) throw new Error(`card: header "${m[1]}" is given twice`);
    fields[m[1]] = m[2].trim();
  }
  const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? basename(file, '.md');
  const id = /^([A-Z]+-\d+)/.exec(title)?.[1] ?? basename(file, '.md');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`card: id "${id}" must match [A-Za-z0-9._-], max 64 chars`);
  if (!KINDS.includes(fields.kind)) throw new Error(`card ${id}: kind "${fields.kind}" is not one of ${KINDS.join(', ')}`);
  if (!SIZES.includes(fields.size)) throw new Error(`card ${id}: size "${fields.size}" is not one of ${SIZES.join(', ')}`);
  const acceptance = list(fields.acceptance);
  for (const a of acceptance) if (!NAME.test(a)) throw new Error(`card ${id}: acceptance name "${a}" must match [A-Za-z0-9_-]+`);
  return {
    id,
    title,
    kind: fields.kind,
    size: fields.size,
    paths: list(fields.paths),
    allowEdits: list(fields.allowEdits),
    acceptance,
    heldOut: fields.heldOut || null,
    text,
  };
}

export const readCard = (file) => parseCard(readFileSync(file, 'utf8'), file);

/**
 * A path with symlinks resolved and, on a case-insensitive filesystem, its true letter case (realpath.native), so an alias
 * of the repo (`/var` for `/private/var`, or a directory named in other letter case) cannot pass an in-repo card off as outside it
 * (REQ-CARD-3). A missing file resolves through its parent.
 */
function canonical(path) {
  const p = resolve(path);
  if (existsSync(p)) return realpathSync.native(p);
  return join(canonical(dirname(p)), basename(p));
}

/** A card inside the repo is read from the base commit, so the change under test cannot rewrite it (REQ-CARD-3). */
export function readTrustedCard(repo, base, file) {
  const rel = relative(canonical(repo), canonical(file));
  if (rel.startsWith('..')) return readCard(file);
  const text = showFile(base, rel, repo);
  if (text === null) throw new Error(`card ${rel} is not in the base commit; commit it to the base first or keep it outside the repo`);
  return parseCard(text, file);
}

/** Card text for the builder: the held-out location is removed so the builder cannot look for it (REQ-GATE-10). */
export const builderText = (card) => card.text.replace(/^[^\S\n]*heldOut:.*(?:\n|$)/gm, ''); // every line parseCard reads as heldOut
