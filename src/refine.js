import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { revParse, showFile, withTempWorktree } from './git.js';
import { cardFromIssue } from './linear.js';
import { appendAttempt } from './ledger.js';
import { startTier } from './run.js';
import { runWorker } from './workers.js';

/** The heading a refined card sits under at the top of the issue description (REQ-LINEAR-33). */
export const REFINED_HEADING = '## Refined by keel';

const KEEL_BLOCK = /```keel[ \t]*\n[\s\S]*?```/;
const SECTION = (name) => new RegExp(`^##\\s+${name}\\b`, 'im');
const SHALL_LINE = /^.*\bshall\b.*$/gim;
const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]\s+\S/m;
/** An open acceptance checkbox `- [ ] <check>`: a refined card's checks are still to do (REQ-LINEAR-33). */
const OPEN_CHECKBOX = /^\s*[-*]\s+\[ \]\s+\S/m;
/** More EARS lines than this is too big for one S/M card (REQ-LINEAR-32). */
const MAX_SHALL = 8;
/** A description longer than this is too big for one S/M card (REQ-LINEAR-32). */
const MAX_CHARS = 8000;

/**
 * Why an issue needs a refine turn before it is built (REQ-LINEAR-32), or null when it is buildable as written. An issue
 * with a `keel` block, Requirements, and Acceptance is clear (Keel's own follow-ups are, REQ-LINEAR-22), and so is one
 * already refined. Otherwise it needs testable requirements (an EARS `shall` line or an Acceptance checkbox) and must
 * not be obviously too big.
 */
export function refineReason(issue) {
  const text = issue.description ?? '';
  if (text.includes(REFINED_HEADING)) return null;
  if (KEEL_BLOCK.test(text) && SECTION('Requirements').test(text) && SECTION('Acceptance').test(text)) return null;
  const shall = text.match(SHALL_LINE) ?? [];
  const tooBig = [];
  if (typeof issue.estimate === 'number' && issue.estimate > 5) tooBig.push(`estimate ${issue.estimate} (size L)`);
  if (shall.length > MAX_SHALL) tooBig.push(`${shall.length} "shall" lines`);
  if (text.length > MAX_CHARS) tooBig.push(`${text.length} characters`);
  if (tooBig.length) return `too big for one S/M card: ${tooBig.join(', ')}`;
  if (!shall.length && !CHECKBOX.test(text)) return 'no testable requirements (no EARS "shall" line and no Acceptance checkbox)';
  return null;
}

/** The card format the refine turn must write, from skills/cards (REQ-LINEAR-33). Embedded, not referenced. */
const CARD_FORMAT = `<one to three lines of context: who needs this and why>

## Requirements

- REQ-<AREA>-<n>: When <trigger>, the <system> shall <observable response>.

## Acceptance

- [ ] <how a test proves each requirement; name the interface: route, function, CLI, page>

\`\`\`keel
kind: <bug|feature|chore|refactor|ui|infra>
size: <S|M>
paths: <globs the change may touch, test files included>
allowEdits: <only a path the issue's own keel block already allows; omit the line otherwise>
\`\`\``;

/**
 * The refine prompt (REQ-LINEAR-32, -33): one read-only turn that turns an unclear issue into a buildable card, proves
 * it done, splits it, or asks the owner one specific question. Beside the builder prompt (run.js `buildPrompt`).
 */
export function refinePrompt(issue, keelJson, why) {
  return [
    `You refine Linear issue ${issue.id} into a card that Keel can build unattended. Keel did not build it as written: ${why}.`,
    'This checkout is the base branch. Read the code, tests, and docs you need. Do not edit, create, or delete any file, and do not commit: this turn is read-only.',
    '',
    'Reply with exactly one of these four answers. The first line of your reply must be the keyword line; write nothing before it.',
    '',
    '1. CARD — the issue is buildable once written clearly. First line: `CARD`. Then the card, in this exact format:',
    '',
    CARD_FORMAT,
    '',
    'Card rules: one observable behavior, small enough to build and merge alone (size S or M). Every requirement is one EARS line ("When <trigger>, the <system> shall <response>") with an acceptance checkbox a test can check. Name behavior and interfaces; never prescribe the implementation. A card that only adds tests for existing behavior sets `kind: chore` and says "put the new tests in a new test file". Keep the kind of the issue when it is bug or feature. Existing test files and files that define passing (CI workflows, runner and lint configs, keel.json) are locked: `allowEdits` may only repeat paths the issue\'s own keel block already allows; Keel rejects a card that adds one.',
    '',
    '2. ALREADY_DONE — the current code already does what the issue asks. One line: `ALREADY_DONE commit <sha>` or `ALREADY_DONE PR #<n>`, naming the commit or merged PR that did it. Keel verifies it and runs the checks before it closes the issue.',
    '',
    '3. SPLIT — the issue is too big for one card. First line: `SPLIT`. Then 2 to 5 cards in build order, each starting with a line `TITLE: <imperative title, at most 70 characters>` followed by the card in the format above, size S or M. Keel files them as sub-issues; each waits for the one before it.',
    '',
    '4. NEEDS_HUMAN — only for real ambiguity or infeasibility that the code cannot settle (a product decision, contradictory requirements, an external condition). One line: `NEEDS_HUMAN <one specific question the owner can answer>`, for example `NEEDS_HUMAN braces has no patched version: accept the risk or replace the dependency?`.',
    '',
    'Prefer CARD. Use NEEDS_HUMAN only when no reasonable reading of the issue and the code gives a testable card.',
    '',
    '# keel.json',
    keelJson ?? '(none: Keel defaults apply)',
    '',
    `# Issue ${issue.id}: ${issue.title}`,
    '',
    issue.description || '(no description)',
  ].join('\n');
}

const KEYWORD = /^(CARD|ALREADY_DONE|SPLIT|NEEDS_HUMAN)(?:[ \t]+(.*))?$/;

/**
 * The text under a `## <name>` heading up to the next heading or code fence, or null when the body has no such heading.
 */
function sectionText(body, name) {
  const heading = SECTION(name).exec(body);
  if (!heading) return null;
  const rest = body.slice(heading.index + heading[0].length).replace(/^.*\n?/, '');
  const end = rest.search(/^(?:#{1,6}\s|```)/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Why a refined card body is not a buildable card (REQ-LINEAR-33), or null: it needs a `shall` line under
 * `## Requirements`, an open checkbox under `## Acceptance`, and a `keel` block with kind, size S or M, and paths that
 * map to a valid card.
 */
function cardProblem(issue, body) {
  if (!/\bshall\b/i.test(sectionText(body, 'Requirements') ?? '')) return 'no "## Requirements" with a "shall" line';
  if (!OPEN_CHECKBOX.test(sectionText(body, 'Acceptance') ?? '')) return 'no "## Acceptance" with a checkbox';
  if (!KEEL_BLOCK.test(body)) return 'no keel block';
  let card;
  try {
    card = cardFromIssue({ ...issue, description: body });
  } catch (e) {
    return e.message;
  }
  const block = KEEL_BLOCK.exec(body)[0];
  for (const key of ['kind', 'size', 'paths']) if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(block)) return `the keel block has no "${key}"`;
  if (!['S', 'M'].includes(card.size)) return `size ${card.size} is not S or M`;
  // The issue text is untrusted and the card is built unattended: a refined card may not loosen the policy the issue
  // already had. A bug or feature keeps red proof, and allowEdits stays what the issue itself allowed.
  const before = cardFromIssue(issue);
  if (STRICT_KINDS.includes(before.kind) && !STRICT_KINDS.includes(card.kind))
    return `kind ${card.kind} would drop the red proof the issue's kind ${before.kind} needs`;
  const extra = card.allowEdits.filter((p) => !before.allowEdits.includes(p));
  if (extra.length) return `allowEdits ${extra.join(', ')} is not in the issue's own keel block`;
  return null;
}

/** Kinds whose oracle is red proof (§6.3): a refined card keeps one of them. */
const STRICT_KINDS = ['bug', 'feature'];

/**
 * The refine turn's answer (REQ-LINEAR-33), parsed strictly: `{ kind: 'card', body }`, `{ kind: 'done', evidence }`,
 * `{ kind: 'split', cards: [{ title, body }] }`, `{ kind: 'human', question }`, or `{ kind: 'unparsed', why }`.
 */
export function parseRefine(text, issue) {
  // An exec worker prints its result JSON on the last line (workers.js); it is not part of the answer.
  const lines = text.trim().split('\n');
  if (lines.length && /^\{.*\}$/.test(lines.at(-1).trim())) lines.pop();
  const reply = lines.join('\n').trim();
  const head = KEYWORD.exec(reply.split('\n')[0].trim());
  if (!head)
    return {
      kind: 'unparsed',
      why: `the first line is not CARD, ALREADY_DONE, SPLIT, or NEEDS_HUMAN: "${reply.split('\n')[0].slice(0, 120)}"`,
    };
  const [, keyword, arg = ''] = head;
  const rest = reply.split('\n').slice(1).join('\n').trim();
  if (keyword === 'NEEDS_HUMAN') {
    const question = arg.trim();
    if (!question) return { kind: 'unparsed', why: 'NEEDS_HUMAN names no question' };
    return { kind: 'human', question: question.slice(0, 500) };
  }
  if (keyword === 'ALREADY_DONE') {
    const raw = arg.trim();
    const evidence = /^[0-9a-f]{7,40}$/i.test(raw) ? `commit ${raw}` : /^#\d+$/.test(raw) ? `PR ${raw}` : raw;
    if (!/\bcommit\s+[0-9a-f]{7,40}\b|\bPR\s*#\d+\b/i.test(evidence))
      return { kind: 'unparsed', why: 'ALREADY_DONE names no commit or PR' };
    return { kind: 'done', evidence };
  }
  if (keyword === 'CARD') {
    const why = cardProblem(issue, rest);
    return why ? { kind: 'unparsed', why: `the card is not buildable: ${why}` } : { kind: 'card', body: rest };
  }
  const parts = rest.split(/^TITLE:[ \t]*/m).slice(1);
  if (parts.length < 2 || parts.length > 5) return { kind: 'unparsed', why: `SPLIT needs 2 to 5 cards, got ${parts.length}` };
  const cards = [];
  for (const [i, part] of parts.entries()) {
    const [title, ...body] = part.split('\n');
    if (!title.trim()) return { kind: 'unparsed', why: `split card ${i + 1} has no title` };
    const text = body.join('\n').trim();
    const why = cardProblem(issue, text);
    if (why) return { kind: 'unparsed', why: `split card ${i + 1} is not buildable: ${why}` };
    cards.push({ title: title.trim().slice(0, 200), body: text });
  }
  return { kind: 'split', cards };
}

/**
 * One refine turn (REQ-LINEAR-32): the start tier of the issue's card, on a temporary checkout of base, read-only. It
 * appends a ledger row with role `refine` (REQ-LED-17) and returns `{ status, output, parsed, tier }`; a worker that does
 * not end `ok` is `unparsed` with its status, so the caller builds the issue as written.
 */
export function refineIssue({ repo, base, config, issue, why, log = () => {} }) {
  const index = startTier(cardFromIssue(issue), config);
  const t = config.tiers[index];
  const baseSha = revParse(base, repo);
  log(`${issue.id}: refine turn on tier ${index} ${t.provider}/${t.model}/${t.effort}: ${why}`);
  const w = withTempWorktree(repo, baseSha, (dir) =>
    runWorker(t, refinePrompt(issue, showFile(baseSha, 'keel.json', repo), why), dir, config),
  );
  const parsed = w.status === 'ok' ? parseRefine(w.text ?? '', issue) : { kind: 'unparsed', why: `the refine worker ended ${w.status}` };
  appendAttempt({
    run: `refine-${randomUUID()}`,
    card: issue.id,
    repo: resolve(repo),
    base: baseSha,
    attempt: 0,
    role: 'refine',
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
  });
  return { status: w.status, output: w.output, parsed, tier: index };
}
