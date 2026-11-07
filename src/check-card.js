import { CardError, readCard } from './config.js';
import { exec, revParse } from './git.js';
import { cardFromIssue, exactPaths, markedNew } from './linear.js';
import { UsageError } from './usage.js';

/** An argument that looks like a Linear issue ID (REQ-CLI-8, REQ-CARD-7). */
export const ISSUE_ID = /^[A-Z]+-[0-9]+$/;

/**
 * The card's exactly named paths that are not in `base` and that its text does not mark new (REQ-LINEAR-44): a
 * dependency not merged yet, a card for another repo, or a file that does not exist yet would stop the build for a human.
 * `keel poll` and `keel check-card` both call this one function, so they judge a card alike (REQ-CARD-10).
 */
export function missingOnBase(repo, base, card) {
  const wanted = exactPaths(card).filter((p) => !markedNew(card, p));
  if (!wanted.length) return { missing: [] };
  const sha = revParse(base, repo);
  return { sha, missing: wanted.filter((p) => exec('git', ['cat-file', '-e', `${sha}:${p}`], repo).status !== 0) };
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
  const { missing } = missingOnBase(repo, base, card);
  const at = revParse(base, repo).slice(0, 12);
  if (!missing.length) {
    log(`check-card ${card.id}: pass (every exact path is on base ${at} or marked new)`);
    return 0;
  }
  for (const p of missing)
    log(
      `check-card ${card.id}: ${p} is not on base ${at}; if the card creates it, mark it \`${p} (new)\` in paths; else merge its dependency first or fix the path`,
    );
  return 1;
}
