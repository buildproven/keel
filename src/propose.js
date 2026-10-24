import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseCard } from './config.js';
import { exec, git, revParse, showFile, withTempWorktree } from './git.js';
import { appendAttempt, stateDir } from './ledger.js';
import { APPROVAL_LINE, titleKey } from './linear.js';
import { CARD_FORMAT, cardProblem } from './refine.js';
import { skipReserved } from './run.js';
import { matchesAny } from './scan.js';
import { runWorker } from './workers.js';

/** At most this many of each signal go into the prompt (REQ-PROPOSE-1): enough to point, not a dump of the repo. */
const MAX_SIGNALS = 30;
const MARKER = '\\b(TODO|FIXME|HACK|XXX)\\b';

/** A path's name without directories and extensions, lower case: `src/Foo.test.ts` → `foo`. */
const stem = (path) => basename(path).toLowerCase().split('.')[0];

/**
 * What the base commit itself says needs work (REQ-PROPOSE-1), with no model: marker comments (TODO, FIXME, HACK, XXX)
 * and source files whose name no test file path mentions. Read from the commit, never from the working tree.
 */
export function repoSignals(repo, baseSha, config) {
  const files = git(['ls-tree', '-r', '-z', '--name-only', baseSha], repo).split('\0').filter(Boolean);
  const tests = files.filter((f) => matchesAny(f, config.testGlobs));
  const testText = tests.join('\n').toLowerCase();
  const sources = files.filter(
    (f) => matchesAny(f, config.sourceGlobs) && !matchesAny(f, config.testGlobs) && !matchesAny(f, config.verificationPaths),
  );
  const untested = sources.filter((f) => stem(f).length > 1 && !testText.includes(stem(f)));
  // `git grep` exits 1 when nothing matches: that is an answer, not an error.
  const grep = exec('git', ['grep', '-n', '-I', '-E', MARKER, baseSha, '--'], repo);
  if (grep.status > 1) throw new Error(`git grep for markers failed: ${grep.stderr.trim()}`);
  const markers = grep.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(baseSha.length + 1))
    .filter((l) => !matchesAny(l.split(':')[0], config.testGlobs));
  return {
    files: files.length,
    sources: sources.length,
    tests: tests.length,
    markers: markers.slice(0, MAX_SIGNALS).map((l) => l.slice(0, 200)),
    markerCount: markers.length,
    untested: untested.slice(0, MAX_SIGNALS),
    untestedCount: untested.length,
  };
}

const listed = (items, total, none) =>
  items.length ? [...items.map((i) => `- ${i}`), ...(total > items.length ? [`- … and ${total - items.length} more`] : [])] : [none];

/**
 * The propose prompt (REQ-PROPOSE-2): one read-only turn that decides what is most worth building next and writes it
 * as cards in the refine card format. `open` is the work already queued, so nothing is proposed twice.
 */
export function proposePrompt({ signals, keelJson, open, max, focus = null }) {
  return [
    `You decide what is most worth building next in this repository, and write it as at most ${max} cards that Keel can build unattended.`,
    'This checkout is the base branch. Read the README, docs, code, and tests you need. Do not edit, create, or delete any file, and do not commit: this turn is read-only.',
    '',
    'Look for, in this order of value: bugs (a behavior that is wrong today), missing tests for important behavior, a gap between what the README or docs promise and what the code does, quality problems a user would feel (unclear errors, slow paths, rough command-line or user interface), and small features the project plainly lacks. Prefer small, certain wins over large, speculative ones. Propose nothing that is a product decision only the owner can make.',
    focus ? `The owner asks you to focus on: ${focus}` : '',
    '',
    'Reply in one of two forms. The first line of your reply must be the keyword line; write nothing before it.',
    '',
    `1. PROPOSALS — first line \`PROPOSALS\`. Then 1 to ${max} cards, most valuable first, each starting with a line \`TITLE: <imperative title, at most 70 characters>\` followed by the card in this exact format:`,
    '',
    CARD_FORMAT,
    '',
    'Card rules: one observable behavior per card, size S or M. Every requirement is one EARS line ("When <trigger>, the <system> shall <response>") with an acceptance checkbox a test can check. A card that fixes wrong behavior is `kind: bug`; one that only adds tests for existing behavior is `kind: chore` and says "put the new tests in a new test file". Omit `allowEdits`: existing tests and files that define passing stay locked, and Keel rejects a proposed card that unlocks them.',
    '',
    '2. NONE — nothing is worth a card now. One line: `NONE <one sentence on why>`.',
    '',
    '# Signals Keel read from the base commit',
    '',
    `${signals.files} tracked files: ${signals.sources} source, ${signals.tests} test.`,
    '',
    `Marker comments (${signals.markerCount}):`,
    ...listed(signals.markers, signals.markerCount, '(none)'),
    '',
    `Source files whose name no test file mentions (${signals.untestedCount}; a hint, not proof they are untested):`,
    ...listed(signals.untested, signals.untestedCount, '(none)'),
    '',
    '# Work already queued (do not propose it again)',
    ...listed(open, open.length, '(none)'),
    '',
    '# keel.json',
    keelJson ?? '(none: Keel defaults apply)',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

const KEYWORD = /^(PROPOSALS|NONE)(?:[ \t]+(.*))?$/;
/** A proposal has no policy of its own to keep: a chore with no allowEdits is the floor (REQ-PROPOSE-3). */
const NO_POLICY = { kind: 'chore', allowEdits: [] };

/**
 * The propose turn's answer (REQ-PROPOSE-3), parsed strictly: `{ kind: 'none', why }`, `{ kind: 'unparsed', why }`, or
 * `{ kind: 'proposals', cards: [{ title, body }], dropped: [{ title, why }] }`. A card that is not buildable, that
 * repeats queued work or an earlier proposal, or that is past `max` is dropped with its reason, never filed.
 */
export function parseProposals(text, { max, open = [] }) {
  const lines = text.trim().split('\n');
  if (lines.length && /^\{.*\}$/.test(lines.at(-1).trim())) lines.pop(); // an exec worker's result line (workers.js)
  const reply = lines.join('\n').trim();
  const head = KEYWORD.exec(reply.split('\n')[0].trim());
  if (!head) return { kind: 'unparsed', why: `the first line is not PROPOSALS or NONE: "${reply.split('\n')[0].slice(0, 120)}"` };
  if (head[1] === 'NONE') return { kind: 'none', why: (head[2] ?? '').trim().slice(0, 500) || '(no reason given)' };
  const parts = reply
    .split('\n')
    .slice(1)
    .join('\n')
    .split(/^TITLE:[ \t]*/m)
    .slice(1);
  if (!parts.length) return { kind: 'unparsed', why: 'PROPOSALS has no TITLE: card' };
  const seen = new Set(open.map(titleKey));
  const cards = [];
  const dropped = [];
  for (const [i, part] of parts.entries()) {
    const [first, ...rest] = part.split('\n');
    const title = first.trim().slice(0, 200);
    const body = rest.join('\n').trim();
    const why = !title
      ? 'no title'
      : seen.has(titleKey(title))
        ? 'repeats queued work or an earlier proposal'
        : cards.length >= max
          ? `past the ${max} cards asked for`
          : cardProblem({ id: `PROP-${i + 1}`, title }, body, NO_POLICY);
    if (why) {
      dropped.push({ title: title || `card ${i + 1}`, why });
      continue;
    }
    seen.add(titleKey(title));
    cards.push({ title, body });
  }
  return { kind: 'proposals', cards, dropped };
}

/** The tier a propose turn runs on (REQ-PROPOSE-4): `proposeTier`, else the strongest tier, since choosing work is worth it. */
export const proposeTierOf = (config) => config.proposeTier ?? config.tiers.length - 1;

/**
 * One propose turn (REQ-PROPOSE-4) on a temporary checkout of base, read-only. It appends a ledger row with role
 * `propose` and returns `{ status, output, parsed, tier }`.
 */
export function proposeCards({ repo, base, config, open = [], focus = null, reserved = new Map(), log = () => {} }) {
  const index = skipReserved(config.tiers, proposeTierOf(config), 0, reserved, log);
  if (index === null)
    return { status: 'quota', output: '', parsed: { kind: 'unparsed', why: 'every provider is over its plan window' }, tier: null };
  const t = config.tiers[index];
  const baseSha = revParse(base, repo);
  const signals = repoSignals(repo, baseSha, config);
  log(
    `propose turn on tier ${index} ${t.provider}/${t.model}/${t.effort}: ${signals.markerCount} markers, ${signals.untestedCount} files no test names`,
  );
  const prompt = proposePrompt({ signals, keelJson: showFile(baseSha, 'keel.json', repo), open, max: config.proposeMax, focus });
  const w = withTempWorktree(repo, baseSha, (dir) => runWorker(t, prompt, dir, config));
  const parsed =
    w.status === 'ok'
      ? parseProposals(w.text ?? '', { max: config.proposeMax, open })
      : { kind: 'unparsed', why: `the propose worker ended ${w.status}` };
  appendAttempt({
    run: `propose-${randomUUID()}`,
    card: 'propose',
    repo: resolve(repo),
    base: baseSha,
    attempt: 0,
    role: 'propose',
    tier: index,
    provider: t.provider,
    model: t.model,
    effort: t.effort,
    workerStatus: w.status,
    usage: w.usage,
    cost: w.cost,
    durationMs: w.durationMs,
    gatePass: false,
    head: null,
    outcome: parsed.kind,
    proposed: parsed.cards?.length ?? 0,
  });
  return { status: w.status, output: w.output, parsed, tier: index };
}

const KEEL_BLOCK = /```keel[ \t]*\n([\s\S]*?)```/;

/** Where proposed card files for `repo` go (REQ-PROPOSE-5): outside the repo, so `keel run <file>` reads them from disk. */
export const proposedDir = (repo) => join(stateDir(), 'proposed', basename(resolve(repo)));

/**
 * A proposal as a card file (REQ-PROPOSE-5): `# PROP-<n>: <title>`, the keel block's lines as card headers, then the
 * body under `## Context` so no context line reads as a header. Checked with parseCard before it is returned.
 */
export function cardFile(id, { title, body }) {
  const headers = KEEL_BLOCK.exec(body)[1].trim();
  const rest = body.replace(KEEL_BLOCK, '').trim();
  const first = rest.search(/^## /m);
  const context = first === -1 ? rest : rest.slice(0, first).trim();
  const sections = first === -1 ? '' : rest.slice(first);
  const text = `# ${id}: ${title}\n\n${headers}\n\n${context ? `## Context\n\n${context}\n\n` : ''}${sections}\n`;
  parseCard(text, `${id}.md`);
  return text;
}

/** Write each proposal as `PROP-<n>.md`, numbered after the highest already there (REQ-PROPOSE-5); returns the paths. */
export function writeProposals(repo, cards) {
  const dir = proposedDir(repo);
  mkdirSync(dir, { recursive: true });
  const taken = readdirSync(dir).map((f) => Number(/^PROP-(\d+)\.md$/.exec(f)?.[1] ?? 0));
  let n = Math.max(0, ...taken);
  return cards.map((c) => {
    const id = `PROP-${++n}`;
    const path = join(dir, `${id}.md`);
    writeFileSync(path, cardFile(id, c), { flag: 'wx' });
    return path;
  });
}

/** Titles of the card files already proposed for `repo` (REQ-PROPOSE-5), so a second run does not repeat them. */
export function proposedTitles(repo) {
  const dir = proposedDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^PROP-\d+\.md$/.test(f))
    .map((f) => parseCard(readFileSync(join(dir, f), 'utf8'), f).title.replace(/^PROP-\d+:\s*/, ''));
}

/**
 * File proposals as Linear issues in the project, priority Low (REQ-PROPOSE-6). With `proposeApproval` each one starts
 * with APPROVAL_LINE, so the loop waits for the owner. Returns the new identifiers.
 */
export async function fileProposals({ client, project, config, cards }) {
  const ids = [];
  for (const c of cards) {
    const hold = config.proposeApproval ? `${APPROVAL_LINE}\n\n` : '';
    ids.push(
      await client.createIssue(
        null,
        { title: c.title, description: `${hold}Proposed by keel propose.\n\n${c.body}\n`, priority: 4 },
        project,
      ),
    );
  }
  return ids;
}
