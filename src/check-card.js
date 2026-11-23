import { CardError, DEFAULTS, readCard } from './config.js';
import { exec, git, revParse, showFile } from './git.js';
import { fold, locksAny, matchesAny } from './scan.js';
import { GLOB_CHAR, cardFromIssue, exactPaths, markedNew } from './linear.js';
import { UsageError } from './usage.js';

/** An argument that looks like a Linear issue ID (REQ-CLI-8, REQ-CARD-7). */
export const ISSUE_ID = /^[A-Z]+-[0-9]+$/;

/**
 * The card's exactly named paths that are not in `base`, that its text does not mark new (REQ-LINEAR-44), and that its
 * `allowEdits` does not list (REQ-CARD-14: a new locked file, such as a new workflow, is authorized there): a dependency
 * not merged yet, a card for another repo, or a file that does not exist yet would stop the build for a human.
 * `keel poll` and `keel check-card` both call this one function, so they judge a card alike (REQ-CARD-10).
 */
export function missingOnBase(repo, base, card) {
  const wanted = exactPaths(card).filter((p) => !markedNew(card, p) && !matchesAny(p, card.allowEdits ?? []));
  if (!wanted.length) return { missing: [] };
  const sha = revParse(base, repo);
  return { sha, missing: wanted.filter((p) => exec('git', ['cat-file', '-e', `${sha}:${p}`], repo).status !== 0) };
}

/** Generated traceability files a test keeps in step with the test files (REQ-CARD-11). */
const TRACEABILITY = ['docs/traceability.json', 'docs/TRACEABILITY.md'];

/**
 * The traceability files on `base` that a bug or feature card's `paths` and `allowEdits` do not cover (REQ-CARD-11): the
 * build adds a test, the repo's traceability test then fails until the file is regenerated, and the build stops as
 * blocked (retire-runway BUI-1939, 2026-11-16).
 */
export function uncoveredTraceability(repo, sha, card) {
  // An empty paths turns the gate's scope check off (src/gate.js), so the card can already edit the file.
  if (!['bug', 'feature'].includes(card.kind) || !card.paths.length) return [];
  const scope = [...card.paths, ...(card.allowEdits ?? [])];
  return TRACEABILITY.filter((p) => exec('git', ['cat-file', '-e', `${sha}:${p}`], repo).status === 0 && !matchesAny(p, scope));
}

/**
 * The test files a bug or feature card names in `paths` when none of its scope can take a new test (REQ-CARD-12): every
 * named test file is on base and locked (the repo lacks `testFilesCommand` or turns `approveAllowEdits` off, so the gate
 * cannot prove an edit of it, REQ-GATE-44), no `paths` item is marked new or a glob, and no `allowEdits` item is a test. The build then writes its regression test, finds no place for it, and stops as blocked (jobrecon
 * BUI-1942, 2026-11-16). Empty when the card names no test file, or can add one.
 */
export function lockedTestsOnly(repo, sha, card) {
  if (!['bug', 'feature'].includes(card.kind) || !card.paths.length) return [];
  const pick = basePolicy(repo, sha);
  // The gate can prove an edit of an existing test there (REQ-GATE-44), so an existing test file is a home.
  if (pick('approveAllowEdits') && pick('testFilesCommand')) return [];
  const testGlobs = pick('testGlobs');
  const named = exactPaths(card).filter((p) => matchesAny(p, testGlobs));
  if (!named.length) return [];
  const home =
    card.paths.some((p) => GLOB_CHAR.test(p) || p.endsWith('/')) ||
    named.some((p) => markedNew(card, p)) ||
    (card.allowEdits ?? []).some((p) => matchesAny(p, testGlobs));
  return home ? [] : named.filter((p) => exec('git', ['cat-file', '-e', `${sha}:${p}`], repo).status === 0);
}

/**
 * A reader of one `keel.json` key at `sha`, else its default. Only the keys asked for are read: a repo whose keel.json is
 * incomplete still gets its cards checked.
 */
function basePolicy(repo, sha) {
  const text = showFile(sha, 'keel.json', repo);
  const user = text === null ? {} : JSON.parse(text);
  return (k) => (Object.hasOwn(user, k) ? user[k] : DEFAULTS[k]);
}

/**
 * The card's exactly named paths that `verificationPaths` at `sha` locks (letter case folded, as the gate matches them,
 * REQ-GATE-4), that is not genuinely new and its `allowEdits` does not list (REQ-CARD-13). Only a parsed ` (new)` path
 * absent from the base in every letter case is new here; prose that says "new" does not authorize a gate edit. The gate
 * then fails the build on `verification-file-changed` (BUI-2096, 2026-11-21). A glob or a directory in `paths` is not
 * reported: it does not say the card edits a locked file.
 */
export function lockedWithoutAllow(repo, sha, card) {
  // A directory (`.github/workflows/`) is a scope like a glob, so only the items that name one file are judged.
  const files = exactPaths({ ...card, paths: card.paths.filter((p) => !p.endsWith('/')) });
  if (!files.length) return [];
  const verificationPaths = basePolicy(repo, sha)('verificationPaths');
  const newPaths = new Set(exactPaths({ paths: card.newPaths ?? [] }).map(fold));
  const onBase = newPaths.size
    ? new Set(git(['ls-tree', '-r', '-z', '--name-only', sha], repo).split('\0').filter(Boolean).map(fold))
    : new Set();
  return files.filter((p) => {
    const genuinelyNew = newPaths.has(fold(p)) && !onBase.has(fold(p));
    return locksAny(p, verificationPaths) && !genuinelyNew && !matchesAny(p, card.allowEdits ?? []);
  });
}

/**
 * Judge a card against `base` as `keel check-card` and `keel poll` both do (REQ-CARD-10, REQ-CARD-15): missing paths
 * (REQ-CARD-7), uncovered traceability files (REQ-CARD-11), locked tests only (REQ-CARD-12) and locked files without
 * allowEdits (REQ-CARD-13). `messages` holds one line per reason, without a command prefix, in check-card's order; the
 * card would build when it is empty. The lists carry no base sha, so poll can compare reasons across base commits.
 */
export function judgeCard(repo, base, card) {
  const { missing } = missingOnBase(repo, base, card);
  const sha = revParse(base, repo);
  const at = sha.slice(0, 12);
  const traceability = uncoveredTraceability(repo, sha, card);
  const lockedTests = lockedTestsOnly(repo, sha, card);
  const unallowed = lockedWithoutAllow(repo, sha, card);
  const messages = [
    ...traceability.map((p) => `${p} is a traceability file on base ${at}; add it to paths: a new test must be mapped in it`),
    ...(lockedTests.length
      ? [
          `every test file in paths is on base ${at} and locked (${lockedTests.join(', ')}); add a new test file marked \`(new)\` to paths for the regression test`,
        ]
      : []),
    ...unallowed.map((p) => `${p} is locked (verification file); add it to allowEdits if the card must change it`),
    ...missing.map(
      (p) =>
        `${p} is not on base ${at}; if the card creates it, mark it \`${p} (new)\` in paths; else merge its dependency first or fix the path`,
    ),
  ];
  return { sha, missing, traceability, lockedTests, lockedWithoutAllow: unallowed, messages };
}

/** The card of an open issue, as `keel poll` maps it (REQ-LINEAR-2); a mapping error is a CardError (REQ-CARD-9). */
async function issueCard(id, issues) {
  const issue = (await issues()).find((i) => i.id === id);
  if (!issue) throw new UsageError(`check-card: ${id} is not an open issue of the project`);
  try {
    return cardFromIssue(issue);
  } catch (e) {
    if (e instanceof CardError) throw e;
    // REQ-CARD-9, REQ-LINEAR-3: cardFromIssue throws a plain Error for an issue it cannot map (no description, an
    // external block); keel poll skips that issue with the message, so check-card reports the same message.
    throw new CardError(`${id}: ${e.message}`);
  }
}

/**
 * `keel check-card <ISSUE-ID | card.md>` (REQ-CARD-7..10): parse the card as `keel poll` would and list each exactly
 * named path that is not on `base` and not marked new. `issues` returns the project's open issues; it is called only
 * for an issue ID. Returns the exit code: 0 when the card would build, 1 when it would be skipped or deferred.
 */
export async function checkCard({ repo, base, target, issues, log, isFile = () => false }) {
  let card;
  try {
    card = ISSUE_ID.test(target) && !isFile(target) ? await issueCard(target, issues) : readCard(target);
  } catch (e) {
    if (!(e instanceof CardError)) throw e;
    log(e.message); // REQ-CARD-9: the parser's message, before any git read
    return 1;
  }
  if (exec('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`], repo).status !== 0)
    throw new UsageError(`check-card: --base ${base} is not a commit in ${repo}`);
  const { sha, messages } = judgeCard(repo, base, card);
  for (const m of messages) log(`check-card ${card.id}: ${m}`);
  if (messages.length) return 1;
  log(`check-card ${card.id}: pass (every exact path is on base ${sha.slice(0, 12)} or marked new)`);
  return 0;
}
