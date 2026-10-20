import { extname } from 'node:path';
import { builderText, SEVERITIES } from './config.js';
import { git, withTempWorktree } from './git.js';
import { PROSE } from './scan.js';
import { UsageError } from './usage.js';
import { learnLimit, nearlyUsed, recordReviewSpend, windowUse } from './window.js';
import { addUsage, runWorker } from './workers.js';

export const family = (tier) => tier.family ?? tier.provider;
export const label = (t) => `${t.provider}/${t.model}/${t.effort}`;

/**
 * The cross-model reviewer (REQ-GATE-21): the strongest tier whose family differs from the builder's, so a model
 * never reviews its own work (principle 2). With no builder (`keel gate` alone) it is the strongest tier.
 */
export function reviewerFor(config, builder) {
  for (let i = config.tiers.length - 1; i >= 0; i--) if (!builder || family(config.tiers[i]) !== family(builder)) return config.tiers[i];
  return null;
}

/**
 * The reviewers to try, in order, when `reviewer` is unavailable (REQ-GATE-22): every other tier, those of another
 * family than it first (a quota or outage is per provider), each group strongest first. The receipt says a fallback
 * reviewed, since it may share the builder's family.
 */
export function fallbackReviewers(config, reviewer) {
  const others = [...config.tiers].reverse().filter((t) => t !== reviewer && label(t) !== label(reviewer));
  const order = [...others.filter((t) => family(t) !== family(reviewer)), ...others.filter((t) => family(t) === family(reviewer))];
  return order.filter((t, i) => order.findIndex((x) => label(x) === label(t)) === i);
}

export const fallbackReviewer = (config, reviewer) => fallbackReviewers(config, reviewer)[0] ?? null;

/**
 * The fallback that reviews before `reviewer` because the reviewer's quota window is nearly used (REQ-GATE-24): the
 * first fallback whose window is not also nearly used. Null when the window has room, `reviewFallback` is off, or no
 * fallback has room; then the reviewer reviews first.
 */
export function windowFallback(config, reviewer, spendFile) {
  const low = (t) => nearlyUsed(windowUse(spendFile, family(t), config.reviewWindows));
  if (!config.reviewFallback || !low(reviewer)) return null;
  return fallbackReviewers(config, reviewer).find((t) => !low(t)) ?? null;
}

/**
 * Who wrote a change that `keel gate` checks alone (REQ-CLI-9): `--author`, else `KEEL_AUTHOR`, else `claude` inside
 * Claude Code (it sets CLAUDECODE=1), else unknown (null).
 */
export function authorFamily(flag, env) {
  const given = flag ?? (env.KEEL_AUTHOR || undefined); // an empty KEEL_AUTHOR is unset, never "unknown"
  if (given === undefined) return env.CLAUDECODE === '1' ? 'claude' : null;
  if (!/^[a-z][a-z0-9-]*$/.test(given))
    throw new UsageError(`author ${JSON.stringify(given)} must be a model family such as claude or codex`);
  return given;
}

const MAX_DIFF_CHARS = 80000;
const FINDING = /^_{0,2}FINDING_{0,2}:?\s+_{0,2}(critical|high|medium|low|info)_{0,2}:?\s+(.+)$/i;
const AT = /^:(\d+)(?:[-–:]\d+)?:?\s+(.+)$/; // `:N`, `:N-M` or `:N:C`, then the text

/**
 * The findings in a review answer (REQ-GATE-21). A reviewer may write a line as a list item, with emphasis, with the
 * path in backticks, or with a line range or column; the path is matched against the changed paths, longest first, so a
 * path with a space parses. A well-formed finding on an unchanged file is dropped, as before. A `FINDING` line that
 * still does not parse is returned as `{ unparsed: <line> }`; the stage keeps it in the receipt and its line, never
 * blocking, so no finding is lost unseen.
 */
export function parseFindings(text, changed) {
  const paths = [...new Set(changed)].sort((a, b) => b.length - a.length);
  const findings = [];
  for (const raw of text.split('\n')) {
    const l = raw
      .replace(/`/g, '')
      .replace(/\*\*/g, '') // never `__`: paths such as pkg/__init__.py and src/__tests__/ hold it
      .replace(/^\s*(?:[-*+•>]\s+|\d+[.)]\s+)*/, '')
      .trim();
    if (!/^_{0,2}FINDING(?![a-z])/i.test(l)) continue;
    const m = FINDING.exec(l);
    const severity = m?.[1].toLowerCase();
    const rest = m?.[2] ?? '';
    const path = paths.find((p) => rest.startsWith(p) && AT.test(rest.slice(p.length)));
    if (path) {
      const [, line, said] = AT.exec(rest.slice(path.length));
      findings.push({ severity, path, line: Number(line), text: said.trim() });
    } else if (!(m && /^\S+:\d+/.test(rest)) && /^_{0,2}FINDING/.test(l)) findings.push({ unparsed: l });
  }
  return findings;
}
const VERDICT = /^VERDICT:\s*(pass|block)\s*$/im;

const clip = (diff) =>
  diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…(truncated; read the files in this checkout)` : diff;

/**
 * A re-gate (REQ-GATE-23) shows the previous findings and the change since that review, and keeps medium or higher for
 * those: without it each round re-read the whole diff and blocked on new findings in unchanged text, so fixes never
 * converged (BUI-1147). Other defects are still reported, at low, and become follow-ups (REQ-RUN-27).
 */
const previousSection = (previous) =>
  previous
    ? [
        '',
        `# Previous review (at ${previous.head.slice(0, 12)})`,
        ...previous.findings.map((f) => `- ${f.severity} ${f.path}:${f.line} ${f.text}`),
        '',
        '# Change since the previous review',
        clip(previous.delta),
      ]
    : [];

const reviewPrompt = (card, diff, previous) =>
  [
    'You review a change another model made in this git checkout. Do not edit files.',
    'Report only real defects: behavior that contradicts the card, a bug, a security hole, or broken existing behavior. No style notes.',
    'One line per defect: FINDING <critical|high|medium|low> <path>:<line> <what is wrong and why>. Use a path from the diff.',
    ...(previous
      ? [
          'This change was reviewed before; the findings and the change since then are below. Use medium or higher only for a previous finding that is not fixed, or a defect in the change since the previous review. Report any other defect at low.',
        ]
      : []),
    'End with exactly one line: VERDICT: pass or VERDICT: block.',
    '',
    '# Card',
    builderText(card),
    ...previousSection(previous),
    '',
    '# Diff',
    clip(diff),
  ].join('\n');

/**
 * Review stage (REQ-GATE-21). Code still decides: only findings at `reviewBlock` or above that cite a changed file block,
 * so an invented citation cannot fail a change (precision first). A reviewer with no verdict fails closed.
 * A reviewer whose quota window is nearly used gives way to the fallback before the quota runs out (REQ-GATE-24).
 */
export function reviewStage({ repo, base, head, card, config, changed, reviewer, previous = null, spendFile = null }) {
  if (!config.review) return null;
  if (!reviewer) return { name: 'review', pass: false, problems: [{ rule: 'no-cross-reviewer' }] };
  const chain = config.reviewFallback ? fallbackReviewers(config, reviewer) : [];
  // A reviewer whose window is nearly used goes after the first fallback whose window is not (REQ-GATE-24).
  const alt = windowFallback(config, reviewer, spendFile);
  const order = alt ? [alt, reviewer, ...chain.filter((t) => t !== alt)] : [reviewer, ...chain];
  let spent = { cost: null, usage: null };
  let unknown = false; // a reviewer spent tokens at no known price (REQ-LED-12)
  // The priced part still counts toward the card budget (REQ-RUN-22); `unpriced` says the sum is a lower bound.
  const total = () => ({ ...spent, ...(unknown ? { unpriced: true } : {}) });
  let outage = null;
  let primary = null; // the reviewer's own unavailable result, returned when no one answers
  const tried = [];
  const unavailable = []; // why each reviewer gave no verdict, in the order tried (REQ-GATE-26)
  // A provider outage must not stop the loop (REQ-GATE-22): try each in turn until one gives a verdict.
  for (const t of order) {
    const r = reviewWith({ repo, base, head, card, config, changed, reviewer: t, previous, spendFile });
    // Every reviewer that ran spent tokens; the card's budget counts them all (REQ-GATE-21).
    spent = { cost: addCost(spent.cost, r.cost), usage: addUsage(spent.usage, r.usage) };
    unknown ||= unpriced(r);
    const down = r.problems.find((p) => p.rule === 'review-unavailable');
    if (down) {
      if (t === reviewer) [outage, primary] = [down, r];
      else tried.push(r.reviewer);
      unavailable.push(reason(r, down));
      if (down.status === 'quota') learnLimit(spendFile, family(t)); // the next gate switches early (REQ-GATE-27)
      continue;
    }
    const why = unavailable.length ? { unavailable } : {};
    if (t === reviewer) return { ...r, ...total(), ...why };
    const status = outage ? (outage.status === 'ok' ? 'no verdict' : outage.status) : 'window nearly used';
    return { ...r, ...total(), ...why, fallback: { from: label(reviewer), status, ...(tried.length ? { tried } : {}) } };
  }
  return { ...primary, ...total(), unavailable, ...(tried.length ? { tried } : {}) };
}

const RETRY = [/try again at (\d{1,2}:\d{2}\s*(?:AM|PM)?)/i, /resets?(?: at)? (\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?: \([^)]+\))?)/i];

/** The reset time a provider's limit message names, as written (REQ-GATE-26), or null. */
export function retryAt(output) {
  for (const re of RETRY) {
    const m = re.exec(output ?? '');
    if (m) return m[1].trim();
  }
  return null;
}

/** One reviewer that gave no verdict, for the stage line and the keel/gate description (REQ-GATE-26). */
export const outLine = (u) => `${u.reviewer} ${u.status}${u.retryAt ? ` (retry ${u.retryAt})` : ''}`;

function reason(r, down) {
  const at = retryAt(r.output);
  return {
    reviewer: r.reviewer,
    status: down.status === 'ok' ? 'no verdict' : down.status,
    ...(at ? { retryAt: at } : {}),
    output: (r.output ?? '').slice(-500),
  };
}

/** A reviewer that spent tokens at no known price: the summed cost is then a lower bound (REQ-LED-12, -13). */
const unpriced = (w) => Boolean(w.usage) && typeof w.cost !== 'number';
const addCost = (a, b) => (typeof a === 'number' || typeof b === 'number' ? (a ?? 0) + (b ?? 0) : null);

/**
 * Whether the change from `from` to `to` touches only prose files and at most `maxLines` added plus deleted lines
 * (REQ-GATE-25). Binary files and renames never count as small doc changes.
 */
function smallDocChange(repo, from, to, maxLines) {
  const rows = git(['diff', '--numstat', '--no-renames', from, to], repo)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  const lines = rows.reduce((n, [added, deleted]) => n + Number(added) + Number(deleted), 0);
  return rows.length > 0 && rows.every(([, , path]) => PROSE.has(extname(path))) && lines <= maxLines;
}

function reviewWith({ repo, base, head, card, config, changed, reviewer, previous, spendFile }) {
  const diff = git(['diff', '--text', '--no-textconv', base, head], repo);
  const light = config.lightReview;
  // A re-gate of a small doc fix needs less thought than the first read of the change (REQ-GATE-25).
  const effort =
    light && previous && light.effort !== reviewer.effort && smallDocChange(repo, previous.head, head, light.maxLines)
      ? light.effort
      : null;
  return withTempWorktree(repo, head, (dir) => {
    const w = runWorker(effort ? { ...reviewer, effort } : reviewer, reviewPrompt(card, diff, previous), dir, config);
    recordReviewSpend(spendFile, family(reviewer), w.usage); // The window is shared by every session (REQ-GATE-24).
    const meta = { reviewer: label(reviewer), ...(effort ? { effort } : {}), cost: w.cost, usage: w.usage };
    if (w.status !== 'ok' || !VERDICT.test(w.text))
      return {
        name: 'review',
        pass: false,
        problems: [{ rule: 'review-unavailable', status: w.status }],
        output: w.output.slice(-2000),
        ...meta,
      };
    const findings = parseFindings(
      w.text,
      changed.map((f) => f.path),
    );
    // An info finding never blocks, whatever reviewBlock is (REQ-GATE-41).
    const blocks = (f) => SEVERITIES.includes(f.severity) && SEVERITIES.indexOf(f.severity) <= SEVERITIES.indexOf(config.reviewBlock);
    const unparsed = findings.filter((f) => f.unparsed).map((f) => f.unparsed);
    const parsed = findings.filter((f) => !f.unparsed);
    const blocking = parsed.filter(blocks);
    return {
      name: 'review',
      pass: blocking.length === 0,
      problems: blocking.map((f) => ({ rule: 'review-finding', ...f })),
      notes: parsed.filter((f) => !blocks(f)),
      ...(unparsed.length ? { unparsed } : {}),
      ...meta,
    };
  });
}

const APPROVAL = /^(APPROVE|DENY):\s*(.+)$/m;

/**
 * Ask `tiers` in turn, in a scratch checkout of `ref` (whatever they write never reaches the build), until one answers
 * a line `pattern` matches: `APPROVE: …` or `DENY: …` (REQ-RUN-30, REQ-GATE-44), or `DEFECT: …` or `VALID: …`
 * (REQ-RUN-46). Returns { answer: { word, approved, by, reason } | null, cost, usage, unpriced? }, with what every tier
 * that ran spent (REQ-LED-13).
 */
function askApproval({ tiers, prompt, repo, ref, config, pattern = APPROVAL }) {
  let cost = null;
  let usage = null;
  let unknown = false;
  return withTempWorktree(repo, ref, (dir) => {
    let answer = null;
    for (const t of tiers) {
      const w = runWorker(t, prompt, dir, config);
      cost = addCost(cost, w.cost);
      usage = addUsage(usage, w.usage);
      unknown ||= unpriced(w);
      const m = w.status === 'ok' ? pattern.exec(w.text) : null;
      if (m) {
        answer = { word: m[1], approved: m[1] === 'APPROVE', by: label(t), reason: m[2].trim() };
        break;
      }
    }
    return { answer, cost, usage, ...(unknown ? { unpriced: true } : {}) };
  });
}

/**
 * Ask the other family whether a builder may edit existing test files it asked for (REQ-RUN-30). The tiers are tried
 * like reviewers (REQ-GATE-22): the cross-family reviewer first, then the fallbacks. Returns { approved, by, reason, cost, usage, unpriced? }
 * from the first that answers APPROVE or DENY, or null when none does.
 */
export function approveEdits({ config, builder, card, request, paths, cwd }) {
  const first = reviewerFor(config, builder);
  if (!first) return null;
  const prompt = [
    'A builder working on the card below asks to edit existing test files that Keel locks. Do not edit files.',
    "Approve only if the card's requirements make what a test currently asserts wrong, so the test must change with the fix.",
    'Deny a request that would weaken, skip, or delete a check to make a failing test pass, or that the card does not need.',
    'Answer with exactly one line: APPROVE: <the requirement that makes the test wrong> or DENY: <why>.',
    '',
    '# Card',
    builderText(card),
    '',
    '# Files',
    ...paths,
    '',
    "# The builder's reason",
    request,
  ].join('\n');
  const tiers = [first, ...(config.reviewFallback ? fallbackReviewers(config, first) : [])];
  const { answer, ...spent } = askApproval({ tiers, prompt, repo: cwd, ref: 'HEAD', config });
  return answer ? { approved: answer.approved, by: answer.by, reason: answer.reason, ...spent } : null;
}

const HELD_OUT_VERDICT = /^(DEFECT|VALID):\s*(.+)$/m;

/**
 * Ask the other family whether held-out tests that failed the same way on two builds are defective (REQ-RUN-46): the
 * cross-family reviewer first, then the fallbacks (REQ-GATE-22), in a scratch checkout of `head`. `files` are the
 * held-out tests as { path, text }; `output` is their private output on head. Returns { answer: { defect, by, reason }
 * | null, cost, usage, unpriced? }; the spend counts whether or not a tier answered (REQ-LED-13).
 */
export function judgeHeldOut({ config, builder, card, files, output, cwd, head }) {
  const first = reviewerFor(config, builder);
  if (!first) return { answer: null, cost: null, usage: null };
  const prompt = [
    'Held-out acceptance tests, written by another model from the card below, failed on two builds of the card in a row with the same failing test. The builder never sees these tests. This checkout is the latest build. Do not edit files.',
    'Decide whether the tests are defective, so that no correct implementation of the card could pass them: they assert what the card does not require or contradict it, depend on names or structure the card does not give, contradict themselves, or wait for a state that never occurs.',
    'Otherwise they are valid and the build does not meet the card.',
    'Answer with exactly one line: DEFECT: <why> or VALID: <why>.',
    '',
    '# Card',
    builderText(card),
    '',
    '# Held-out tests',
    clip(files.map((f) => `## ${f.path}\n${f.text}`).join('\n\n')),
    '',
    '# Held-out output on this build',
    output,
  ].join('\n');
  const tiers = [first, ...(config.reviewFallback ? fallbackReviewers(config, first) : [])];
  const { answer, ...spent } = askApproval({ tiers, prompt, repo: cwd, ref: head, config, pattern: HELD_OUT_VERDICT });
  return { answer: answer && { defect: answer.word === 'DEFECT', by: answer.by, reason: answer.reason }, ...spent };
}

/**
 * The cross-family verdict on edits to existing test files (REQ-GATE-44): the reviewer, then only fallbacks of its own
 * family, since an answer from the builder's family is not independent. They read the test diff and the card and answer
 * APPROVE (the edited tests check at least as much) or DENY (the edit weakens them). The stage records the answer and
 * the spend; with no answer, or a denial, the files stay locked.
 */
export function testEditStage({ repo, from, head, card, config, reviewer, files }) {
  const result = (pass, why, extra = {}) => ({
    name: 'test-edits',
    pass,
    files,
    problems: pass ? [] : files.map((path) => ({ rule: 'existing-test-changed', path, why })),
    ...extra,
  });
  if (!reviewer) return result(false, 'no cross-family reviewer to approve the edit');
  const prompt = [
    'Another model changed existing test files that Keel locks, while building the card below. Do not edit files.',
    'Decide whether the test diff weakens what the tests check: an assertion removed or loosened, a narrower input, an expected value changed to fit wrong behavior, or a case skipped, deleted, or made unreachable.',
    "A test may change an expected value only where the card's requirements make the old value wrong.",
    'Answer with exactly one line: APPROVE: <why the edited tests check at least as much as before> or DENY: <what the edit weakens>.',
    '',
    '# Card',
    builderText(card),
    '',
    '# Test diff',
    clip(git(['diff', '--text', '--no-textconv', from, head, '--', ...files], repo)),
  ].join('\n');
  const tiers = [
    reviewer,
    ...(config.reviewFallback ? fallbackReviewers(config, reviewer).filter((t) => family(t) === family(reviewer)) : []),
  ];
  const { answer, ...spent } = askApproval({ tiers, prompt, repo, ref: head, config });
  // The tier that answered, else the first one asked, names the spend when no regular review runs (REQ-LED-13).
  spent.reviewer = answer?.by ?? label(reviewer);
  if (!answer) return result(false, `no approval: ${tiers.map(label).join(', ')} gave no APPROVE or DENY line`, spent);
  const approval = { approved: answer.approved, by: answer.by, reason: answer.reason };
  return answer.approved
    ? result(true, null, { approval, ...spent })
    : result(false, `denied by ${answer.by}: ${answer.reason}`, { approval, ...spent });
}
