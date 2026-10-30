import { removeParkedWorktree } from './clean.js';
import { exec, isDirty, revParse, showFile } from './git.js';
import { ALREADY_SATISFIED, verifyDone } from './done.js';
import {
  attemptedIssueIds,
  cardFromIssue,
  filedToday,
  notKeelIssueIds,
  notKeelReason,
  pendingFollowUps,
  pickIssue,
  recordPollAttempt,
  textPrerequisites,
  titleKey,
} from './linear.js';
import { resolve } from 'node:path';
import { cardLease, describeConflicts } from './lease.js';
import { readLedger, spentToday, stateDir } from './ledger.js';
import { finishSelfMerges, recordSelfMerge } from './merge.js';
import { REFINED_HEADING, refineIssue, refineReason } from './refine.js';
import { networkFailure } from './network.js';
import { nextReset, planLine, readPlan, reservedProviders, savePlan } from './plan.js';
import { run } from './run.js';
import { locksAny, matchesAny } from './scan.js';
import { UsageError } from './usage.js';

// Stops caused by a provider, not by the card or the code (REQ-LINEAR-19).
const TRANSIENT_STOPS = new Set(['quota', 'review-unavailable']);

/**
 * Exit code of `keel poll` and `keel run <ISSUE-ID>` (REQ-RUN-20): 1 when a run failed, was blocked,
 * lost its PR, or its auto-merge call or a self-merge (REQ-MERGE-3) failed; 3 when budget, a provider, or a path lease (REQ-LEASE-3) deferred work;
 * else 0.
 */
export function pollExitCode(results) {
  if (
    results.some(
      (r) =>
        ['failed', 'blocked', 'needsHuman', 'prFailed', 'followUpsFailed', 'mergeFailed', 'closeFailed'].includes(r.outcome) ||
        r.result?.merge?.state === 'failed',
    )
  )
    return 1;
  return results.some((r) => ['budget', 'plan', 'deferred', 'leased'].includes(r.outcome)) ? 3 : 0;
}

const trim = (s, n = 4000) => (s && s.length > n ? `…${s.slice(-n)}` : s);

function passedComment({ tier, attempt, branch, pr, merge }) {
  const prLine = `${pr?.ok ? `\nPR: ${pr.out}` : ''}${merge && merge.state !== 'auto' ? `\nAuto-merge ${merge.state}: ${merge.reason}` : ''}`;
  return `keel: passed on tier ${tier}, attempt ${attempt}. Branch: \`${branch}\`.${prLine}\nMoved to review: check the diff, open or merge the PR (\`Closes <ID>\`), then this closes.`;
}

function failedComment({ stopped, failure, worktree }) {
  return `keel: stopped (${stopped}) after all attempts.\n\n${trim(failure) ?? '(no failure detail)'}\n\nWorktree kept at ${worktree}.`;
}

function blockedComment({ failure, worktree }) {
  return `keel: the worker reported the card blocked, so no stronger model was tried (REQ-RUN-13).\n\n${trim(failure)}\n\nFix the card or the repo, then retry with \`keel poll --issue <ID>\`. Worktree kept at ${worktree}.`;
}

/** The comment that closes an issue proven already done (REQ-LINEAR-30): the worker's claim and the evidence that held. */
function doneComment({ evidence, checks, baseSha }, { failure, branch }) {
  return `keel: already done, closed without a build. Evidence: ${evidence.join('; ')}; checks green on base ${baseSha.slice(0, 12)}: ${checks.join(', ') || '(none configured)'}.\n\nThe worker said:\n${trim(failure, 1500)}\n\nKeel's empty branch \`${branch}\` is not needed; remove it with \`keel clean\`.`;
}

/**
 * Move an issue proven done to Done, then post `comment` (REQ-LINEAR-30). Done comes first, so a failed move never
 * leaves a "closed" comment on an open issue: Keel says instead that it stays open, and the error goes on.
 */
async function closeDone(client, id, comment) {
  try {
    await client.done(id);
  } catch (e) {
    // No network, no comment either: the poll stops (REQ-LINEAR-40) with the issue left open.
    if (networkFailure(e)) throw e;
    // The failed move stays the error: a comment that fails too is added to it, never put in its place.
    await client
      .comment(
        id,
        `keel: the evidence that this issue is already done held, but keel could not move it to Done (${e.message}), so it stays open. Close it by hand, or retry with \`keel poll --issue ${id}\`.`,
      )
      .catch((c) => {
        throw new Error(`${e.message}; the comment that says the issue stays open failed too: ${c.message}`, { cause: e });
      });
    throw e;
  }
  await client.comment(id, comment);
}

/** The test globs that cover the repo's test files at `ref`, each adding files the earlier ones miss (REQ-LINEAR-22). */
function testPathsAt(repo, ref, config) {
  const r = exec('git', ['ls-tree', '-r', '-z', '--name-only', ref], repo);
  if (r.status !== 0) return [];
  const tests = r.stdout.split('\0').filter((p) => p && matchesAny(p, config.testGlobs));
  const kept = [];
  for (const glob of config.testGlobs) if (tests.some((p) => matchesAny(p, [glob]) && !matchesAny(p, kept))) kept.push(glob);
  return kept;
}

/** One EARS requirement for a finding (REQ-LINEAR-22): "When …, the … shall …". */
function earsLine(f, path) {
  const what = f.title.trim().replace(/\.$/, '');
  const where = path ? `the code in \`${path}\`` : 'the code';
  if (f.kind === 'feature') return `When this change is in, ${where} shall provide: ${what}.`;
  if (f.kind === 'chore') return `When this change is in, the project shall have: ${what}, with behavior unchanged.`;
  return `When the case this finding describes runs, ${where} shall no longer show this problem: ${what}.`;
}

/**
 * The description of a found-work issue (REQ-LINEAR-22): a card in the skills/cards format the loop can build without a
 * refine turn (REQ-LINEAR-32). Context names the source issue, commit, and PR; Problem quotes the cited line
 * (REQ-LINEAR-27); one EARS requirement; an acceptance checkbox naming the proving test; a keel block with kind, size S,
 * and paths. A finding on a file the gate locks also names that file in `allowEdits`, and says the edit must keep every
 * check (REQ-LINEAR-29).
 */
/** The path a queued finding cites (REQ-LINEAR-22, -27), or null. */
const findingPath = (f, repo, base) => f.cite?.path ?? citation(f, filesAt(repo, base))?.path ?? null;

/** The line that names the file whose later findings Keel appends to a findings card (REQ-LINEAR-38). */
const appendMarker = (path) => `Keel adds later findings in \`${path}\` to this card.`;

/** One finding as a `## Problem` bullet: the title, the detail, and the quoted cited line when stored (REQ-LINEAR-27). */
const problemItem = (f) =>
  `- ${f.title}${f.detail ? ` (${f.detail})` : ''}${f.cite?.text ? `\n\n\`${f.cite.path}:${f.cite.line}\` reads:\n\n> ${f.cite.text}` : ''}`;

function followUpText(source, f, config, repo, base) {
  const path = findingPath(f, repo, base);
  const locked = path && locksAny(path, config.verificationPaths) ? path : null;
  const commit = f.found?.commit ?? f.cite?.ref ?? null;
  const pr = f.found?.pr ?? null;
  const seen = [commit && `commit ${commit.slice(0, 12)}`, pr && `PR ${pr}`].filter(Boolean).join(', ');
  const context = [
    `Found by keel${source ? ` while building ${source}` : ''}.`,
    `Keel ${source ? 'found this outside that card' : 'found this in a review of merged work'}, so it was filed, not fixed${seen ? `; seen at ${seen}` : ''}.`,
    ...(path ? [appendMarker(path)] : []),
  ];
  const acceptance =
    f.kind === 'chore'
      ? 'New tests in a new test file prove the requirement; no existing test file changes.'
      : 'A new test that fails before the change and passes after it proves the requirement.';
  const dir = path?.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/**` : path;
  const paths = path ? [dir, ...testPathsAt(repo, base, config).filter((g) => g !== dir), '**/*.md'] : [];
  const block = [
    `kind: ${f.kind}`,
    'size: S',
    ...(paths.length ? [`paths: ${paths.join(', ')}`] : []),
    ...(locked ? [`allowEdits: ${locked}`] : []),
  ];
  const lockNote = locked
    ? `\n\nThe fix edits \`${locked}\`, a file the gate locks because it defines what passing means; \`allowEdits\` allows that edit. The edit must not remove or weaken any check, job, or test step.`
    : '';
  return (
    [
      context.join('\n'),
      `## Problem\n\n${problemItem(f)}`,
      `## Requirements\n\n- ${earsLine(f, path)}${lockNote}`,
      `## Acceptance\n\n- [ ] ${acceptance}`,
      `\`\`\`keel\n${block.join('\n')}\n\`\`\``,
    ].join('\n\n') + '\n'
  );
}

// A `path:line` citation in a finding (REQ-LINEAR-27): a path with a `/` or `.`, not inside a longer token, and a line
// number no letter or digit follows (a closing `_` of Markdown emphasis may).
const CITE = /(?<![\w./@-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*):(\d+)(?![\dA-Za-z])/g;
const CITE_SPAN = 300; // how many characters before `:line`, on its line, a cited path may span

/**
 * The first `path:line` a finding cites in its detail, then its title, or null. Text cannot tell where a path starts
 * when it holds spaces or sits in quotes or emphasis (`medium .github/workflows/quality gate.yml:3`,
 * `__init__ file.py:3_`), so the longest text ending right before `:line` on that line that is one of `files` (the
 * paths in the commit the finding is about) is the path; with no such file, the token before `:line` is.
 */
function citation(f, files = new Set()) {
  for (const text of [f.detail, f.title])
    for (const m of (text ?? '').matchAll(CITE)) {
      if (!/[./]/.test(m[1]) || m[1].endsWith('.')) continue;
      const end = m.index + m[1].length;
      let path = m[1];
      for (let i = Math.max(text.lastIndexOf('\n', end) + 1, end - CITE_SPAN); i < end; i++)
        if (files.has(text.slice(i, end))) {
          path = text.slice(i, end);
          break;
        }
      return { path, line: Number(m[2]) };
    }
  return null;
}

/** Every file path at `ref`, for `citation`. */
function filesAt(repo, ref) {
  const r = exec('git', ['ls-tree', '-r', '-z', '--name-only', '--end-of-options', ref], repo);
  if (r.status !== 0) throw new Error(`git ls-tree ${ref} failed: ${r.stderr.trim()}`);
  return new Set(r.stdout.split('\0').filter(Boolean));
}

/** The trimmed text of each line of `path` at `ref`, or null when the path or ref is not there. */
function linesAt(repo, ref, path) {
  if (exec('git', ['cat-file', '-e', `${ref}^{commit}`], repo).status !== 0) return null;
  const text = showFile(ref, path, repo);
  return text === null ? null : text.split('\n').map((l) => l.trim());
}

/**
 * Whether line `line` of `path` at `ref` was there at `fork` (REQ-LINEAR-27): `git blame` over `fork..ref` marks it
 * `boundary` when no commit after `fork` added it. The occurrence counts, not the text: a duplicate the branch added
 * of an older line is the branch's. Porcelain output does not change with the user's diff settings; no ignored revs.
 */
function lineFrom(repo, fork, ref, path, line) {
  // `git blame X..X` blames HEAD instead, so a cited commit already on base (an audit) is its own fork: the line is there.
  if (revParse(ref, repo) === fork) return true;
  const b = exec('git', ['blame', '--porcelain', '--ignore-revs-file=', '-L', `${line},${line}`, `${fork}..${ref}`, '--', path], repo);
  if (b.status !== 0) throw new Error(`git blame ${fork}..${ref} -- ${path} failed: ${b.stderr.trim()}`);
  return /^boundary$/m.test(b.stdout);
}

/**
 * Why a queued finding no longer applies on `base` (REQ-LINEAR-27), or null. Only a line that was there before the
 * finding's own work (at the merge base of its commit and `base`) can go stale: then the file must still exist on
 * `base` and still hold the cited line. A line the finding's unmerged branch added is never judged stale.
 */
function staleReason(repo, base, cite) {
  if (!cite?.text) return null;
  const fork = exec('git', ['merge-base', cite.ref, base], repo);
  if (fork.status !== 0) return null;
  if (!lineFrom(repo, fork.stdout.trim(), cite.ref, cite.path, cite.line)) return null;
  const now = linesAt(repo, base, cite.path);
  if (now === null) return `${cite.path} no longer exists on ${base}`;
  return now.includes(cite.text) ? null : `${cite.path}:${cite.line} no longer reads "${cite.text.slice(0, 120)}" on ${base}`;
}

/** A findings card takes appends up to this many findings, so it stays one card of size S or M (REQ-LINEAR-38). */
const FINDINGS_PER_CARD = 5;
/** States of a card that takes appends: never `started`, where a builder may hold it (REQ-LINEAR-38). */
const APPEND_STATES = ['backlog', 'unstarted', 'triage'];
const PROBLEM = /\n## Problem\n\n[\s\S]*?(?=\n\n## Requirements\n)/;
const REQUIREMENTS = /\n## Requirements\n\n[\s\S]*?(?=\n\n## Acceptance\n)/;

/** The `kind:` of a description's keel block, or null (REQ-LINEAR-38). */
const cardKind = (description) => /```keel\n(?:[^`]*\n)?kind:\s*(\w+)/.exec(description ?? '')?.[1] ?? null;

/**
 * `description` with finding `f` on `path` appended (REQ-LINEAR-38): its bullet at the end of `## Problem`, its EARS
 * line at the end of `## Requirements`; null when a section is missing or the card holds FINDINGS_PER_CARD findings.
 */
function appendFinding(description, f, path) {
  const problem = PROBLEM.exec(description);
  if (!problem || !REQUIREMENTS.test(description)) return null;
  if (problem[0].split('\n').filter((l) => l.startsWith('- ')).length >= FINDINGS_PER_CARD) return null;
  const at = problem.index + problem[0].length;
  const d = `${description.slice(0, at)}\n${problemItem(f)}${description.slice(at)}`;
  const reqs = REQUIREMENTS.exec(d);
  const end = reqs.index + reqs[0].length;
  return `${d.slice(0, end)}\n- ${earsLine(f, path)}${d.slice(end)}`;
}

/**
 * Archive the polled project's closed issues (REQ-LINEAR-39), so they stop counting toward Linear's Free-plan limit.
 * Returns the poll results to add: none, or one `followUpsFailed` when Linear failed, so the poll exits 1 and goes on.
 */
async function archiveClosed(archiveFn, log) {
  if (!archiveFn) return [];
  try {
    const ids = await archiveFn();
    if (ids.length) log(`archived ${ids.length} closed issue(s): ${ids.join(', ')}`);
    return [];
  } catch (e) {
    // An unreachable network stops the poll (REQ-LINEAR-40): every later Linear call would fail the same way.
    if (networkFailure(e)) throw e;
    // Every other Linear error here is logged and fails the poll, never stops it (REQ-LINEAR-39).
    log(`closed issues not archived: ${e.message}`);
    return [{ outcome: 'followUpsFailed', detail: `closed issues not archived: ${e.message}` }];
  }
}

/** A found item whose title an issue closed this many days ago has is done or was declined (REQ-LINEAR-22). */
const DUP_CLOSED_DAYS = 30;

/**
 * File queued found work as Low issues in the same project (REQ-LINEAR-22), oldest first: a title an open issue already
 * has is marked `dup`; at followUpsPerDay for this repo today the rest waits in the queue for a later poll. Each item
 * leaves the queue when its issue is created, marked `dup`, or failed FILE_TRIES times. At followUpHoldAt unarchived
 * issues in the workspace, nothing more is filed and the rest waits, logged and recorded as `held` (REQ-LINEAR-37); an
 * unreadable count is a filing error that counts no try. Filed issues are not attempts,
 * so the loop builds them. A Linear error never stops a poll: it returns `{ error }`, and the poll reports it.
 */
async function fileFollowUps({ repo, project, config, client, log, base = 'HEAD', capacityFn = null }) {
  const pending = pendingFollowUps(repo, FILE_TRIES);
  if (!pending.length || !(config.followUpsPerDay > 0)) return {};
  const filed = new Map(); // source → new issue IDs
  const sourceOpen = new Map(); // source → still open, so its follow-up waits for it (REQ-LINEAR-28)
  const isOpen = async (id) => {
    if (!sourceOpen.has(id)) sourceOpen.set(id, !['completed', 'canceled'].includes(await client.stateType(id)));
    return sourceOpen.get(id);
  };
  const errors = [];
  // A comment is a notice about filing, not the filing: its Linear error is collected and returned like any other
  // filing error, so it never stops a poll (REQ-LINEAR-22).
  const notify = async (id, body) => {
    try {
      await client.comment(id, body);
    } catch (e) {
      if (networkFailure(e)) throw e; // REQ-LINEAR-40
      errors.push(`comment on ${id}: ${e.message}`);
    }
  };
  const report = async (failed) => {
    for (const [source, ids] of filed)
      if (source)
        await notify(
          source,
          `keel: follow-ups filed: ${ids.join(', ')}${failed ? '; filing the rest failed.' : '. The loop builds them in priority order.'}`,
        );
  };
  let current = null;
  let unarchived = null; // the workspace's unarchived issues, once read (REQ-LINEAR-37)
  // Every Linear error is caught here (REQ-LINEAR-22), recorded against the item, and returned, so one bad item cannot
  // stop every later poll.
  try {
    const listed = await client.listIssues(project, { closedWithinDays: DUP_CLOSED_DAYS });
    const known = new Set(listed.map((i) => titleKey(i.title)));
    // A finding already appended to a card is in its description, not its title (REQ-LINEAR-38).
    const texts = listed.map((i) => (i.description ?? '').toLowerCase());
    let cards = null; // open findings cards that take appends, oldest first, read once (REQ-LINEAR-38)
    for (const f of pending) {
      if (known.has(titleKey(f.title)) || texts.some((t) => t.includes(titleKey(f.title)))) {
        recordPollAttempt(repo, { issue: f.source, outcome: 'dup', detail: { source: f.source, title: f.title } });
        continue;
      }
      // Fixed on the base since it was found: filing it would only make a builder report "already satisfied" (REQ-LINEAR-27).
      const stale = staleReason(repo, base, f.cite);
      if (stale) {
        recordPollAttempt(repo, { issue: f.source, outcome: 'stale', detail: { source: f.source, title: f.title, reason: stale } });
        log(`follow-up "${f.title}" dropped as stale: ${stale}`);
        continue;
      }
      // A finding on a file an open findings card names goes into that card: it adds no issue, so neither the daily
      // cap nor the workspace hold applies (REQ-LINEAR-38).
      const path = findingPath(f, repo, base);
      if (path) {
        cards ??= (await client.listIssues(project, { stateTypes: APPEND_STATES })).sort((a, b) =>
          String(a.createdAt).localeCompare(String(b.createdAt)),
        );
        // A card takes the finding only when its kind is the finding's (a bug never runs as a chore without red proof),
        // and when the finding's open source already blocks it, so the card still waits for that source (REQ-LINEAR-28).
        const waits = f.source && (await isOpen(f.source));
        let into = null;
        let text = null;
        for (const c of cards)
          if (
            (c.description ?? '').split('\n').includes(appendMarker(path)) &&
            cardKind(c.description) === f.kind &&
            (!waits || (c.blockedBy ?? []).includes(f.source)) &&
            (text = appendFinding(c.description, f, path))
          ) {
            into = c;
            break;
          }
        if (into) {
          current = f;
          await client.setDescription(into.id, text);
          current = null;
          into.description = text;
          texts.push(text.toLowerCase());
          recordPollAttempt(repo, { issue: into.id, outcome: 'appended', detail: { source: f.source, title: f.title, into: into.id } });
          log(`follow-up "${f.title}" appended to ${into.id}`);
          filed.set(f.source, [...(filed.get(f.source) ?? []), `appended to ${into.id}`]);
          continue;
        }
      }
      if (filedToday(repo) >= config.followUpsPerDay) {
        log(`follow-up cap reached (${config.followUpsPerDay} per day); ${pending.length - pending.indexOf(f)} wait in the queue`);
        break;
      }
      // The workspace's room is read once, just before the first issue this pass would file (REQ-LINEAR-37).
      if (config.followUpHoldAt > 0 && capacityFn) {
        unarchived ??= (await capacityFn()).open;
        if (unarchived >= config.followUpHoldAt) {
          const waiting = pending.length - pending.indexOf(f);
          recordPollAttempt(repo, { issue: null, outcome: 'held', detail: { open: unarchived, holdAt: config.followUpHoldAt, waiting } });
          log(
            `follow-ups held: ${unarchived} unarchived issues >= ${config.followUpHoldAt} (followUpHoldAt); ${waiting} wait in the queue`,
          );
          break;
        }
      }
      current = f;
      const blockedBy = f.source && (await isOpen(f.source)) ? { blockedBy: [f.source] } : {};
      const id = await client.createIssue(
        f.source,
        { title: f.title.trim(), description: followUpText(f.source, f, config, repo, base), priority: 4, ...blockedBy },
        project,
      );
      current = null;
      if (unarchived !== null) unarchived++;
      recordPollAttempt(repo, { issue: id, outcome: 'filed', detail: { source: f.source, title: f.title } });
      known.add(titleKey(f.title));
      filed.set(f.source, [...(filed.get(f.source) ?? []), id]);
    }
  } catch (e) {
    // An unreachable network stops the poll and charges no item a try (REQ-LINEAR-40): the item did nothing wrong.
    if (networkFailure(e)) throw e;
    const error = e.message;
    if (current) {
      recordPollAttempt(repo, {
        issue: current.source,
        outcome: 'file-error',
        detail: { source: current.source, title: current.title, error },
      });
      if (current.source && current.tries + 1 >= FILE_TRIES)
        await notify(current.source, `keel: could not file follow-up "${current.title}" after ${FILE_TRIES} tries: ${error}`);
    }
    await report(true);
    const all = [error, ...errors].join('; ');
    log(`follow-ups not filed: ${all}`);
    return { error: all };
  }
  await report(false);
  const all = [...filed.values()].flat();
  if (all.length) log(`follow-ups filed: ${all.join(', ')}`);
  if (!errors.length) return {};
  log(`follow-up notice failed: ${errors.join('; ')}`);
  return { error: errors.join('; ') };
}

const FILE_TRIES = 3; // a follow-up Linear rejects this often leaves the queue (REQ-LINEAR-22)

/** The poll result for a filing error, so the poll exits 1 without stopping (REQ-LINEAR-22). */
const filingFailed = (r) => (r.error ? [{ outcome: 'followUpsFailed', detail: r.error }] : []);

/** gh pages through open PRs up to this many, so a repo's older PRs are checked too (REQ-LINEAR-41). */
export const OPEN_PR_LIMIT = 5000;

/**
 * Keel's own open PRs (`keel/<ID>` branches) that GitHub reports as conflicting with their base (REQ-LINEAR-23), or as
 * behind it with auto-merge armed (REQ-LINEAR-41): auto-merge would wait forever, and Keel never moves a certified head.
 * Close each one (GitHub keeps its commits), delete its branch and clean worktree, comment on the issue, and mark it
 * deferred so this poll builds it again on the current base. Without an origin remote or a working `gh`, nothing is checked.
 */
async function rebuildConflicts({ repo, client, log }) {
  if (exec('git', ['remote', 'get-url', 'origin'], repo).status !== 0) return;
  const r = exec(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      String(OPEN_PR_LIMIT),
      '--json',
      'number,headRefName,mergeable,mergeStateStatus,autoMergeRequest',
    ],
    repo,
  );
  if (r.status !== 0) {
    log(`conflict check skipped: gh pr list failed: ${`${r.stdout}${r.stderr}`.trim().slice(0, 300)}`);
    return;
  }
  const prs = JSON.parse(r.stdout);
  // gh lists newest first; at the limit, older PRs went unchecked, so say so (REQ-LINEAR-41).
  if (prs.length >= OPEN_PR_LIMIT) log(`conflict check covered only the newest ${OPEN_PR_LIMIT} open PRs; older ones were not checked`);
  for (const pr of prs) {
    const id = /^keel\/([A-Z]+-\d+)$/.exec(pr.headRefName)?.[1];
    if (!id) continue;
    // A strict branch rule needs an up-to-date branch; with auto-merge armed, a behind PR would never merge (REQ-LINEAR-41).
    const behind = pr.mergeable !== 'CONFLICTING' && pr.mergeStateStatus === 'BEHIND' && Boolean(pr.autoMergeRequest);
    if (pr.mergeable !== 'CONFLICTING' && !behind) continue;
    const why = behind ? 'is behind' : 'conflicts with';
    const wt = worktreeOf(repo, pr.headRefName);
    if (wt && isDirty(wt)) {
      log(`${id}: PR #${pr.number} ${behind ? 'is behind its base' : 'conflicts'}, but ${wt} has uncommitted changes; left as is`);
      continue;
    }
    // Local cleanup first: gh cannot delete a branch a worktree has checked out.
    if (wt) removeParkedWorktree({ repo, path: wt, branch: pr.headRefName });
    else exec('git', ['branch', '-D', pr.headRefName], repo);
    const closed = exec(
      'gh',
      [
        'pr',
        'close',
        String(pr.number),
        '--delete-branch',
        '--comment',
        `keel: this PR ${why} the base branch after later merges; building the issue again on the current base.`,
      ],
      repo,
    );
    if (closed.status !== 0) {
      log(`${id}: could not close PR #${pr.number}: ${`${closed.stdout}${closed.stderr}`.trim().slice(0, 300)}`);
      continue;
    }
    // Deferred before the comment, so a Linear error cannot leave the issue attempted with its PR gone.
    const past = behind ? 'was behind' : 'conflicted with';
    recordPollAttempt(repo, {
      issue: id,
      outcome: 'deferred',
      detail: `PR #${pr.number} ${behind ? 'was behind its base' : 'conflicted'}`,
    });
    await client.comment(id, `keel: PR #${pr.number} ${past} the base branch; building again on the current base.`);
    log(`${id}: PR #${pr.number} ${behind ? 'was behind its base' : 'conflicted'}; building again`);
  }
}

/** The worktree that has `branch` checked out, or null. */
function worktreeOf(repo, branch) {
  const out = exec('git', ['worktree', 'list', '--porcelain'], repo).stdout;
  for (const block of out.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path && block.split('\n').includes(`branch refs/heads/${branch}`)) return path;
  }
  return null;
}

/**
 * Queue a run's found work in the poll ledger (REQ-LINEAR-22), whatever the outcome, so none is lost. `ref` is the
 * commit the findings are about (a run's branch, an audited merge): each item that cites a `path:line` there keeps that
 * line's text and the commit as `cite`, so filing can tell whether the base fixed it since (REQ-LINEAR-27). Each item
 * also keeps that commit and the run's `pr` as `found`, the context of its filed card.
 */
export function queueFollowUps(repo, source, followUps, ref = null, pr = null) {
  if (!followUps?.length) return;
  const sha = ref && exec('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repo);
  const at = sha?.status === 0 ? sha.stdout.trim() : null;
  const files = at && filesAt(repo, at);
  const cited = followUps.map((f) => {
    const c = at && citation(f, files);
    const text = c && linesAt(repo, at, c.path)?.[c.line - 1];
    const found = { ...f, found: { commit: at, pr } };
    return text ? { ...found, cite: { ...c, text, ref: at } } : found;
  });
  recordPollAttempt(repo, { issue: source, outcome: 'found', detail: cited });
}

/** A refine answer as the comment the owner reads (REQ-LINEAR-33). */
const refineHead = (r) => `keel: refine turn (tier ${r.tier})`;

/**
 * The refine step before a build (REQ-LINEAR-32, -33): returns `{ issue }` to build (refined or as written), or
 * `{ outcome }` when this pass builds nothing (split, needs a human, proven done). `refineFn` runs the turn; null skips it.
 */
async function refineStep({ repo, base, config, client, issue, project, log, refineFn, reserved }) {
  if (!refineFn || !config.refineIssues) return { issue };
  const why = refineReason(issue);
  if (!why) return { issue };
  const r = refineFn({ repo, base, config, issue, why, reserved, log });
  const p = r.parsed;
  if (p.kind === 'unparsed') {
    // A visible failure, never a silent one: the issue is built as written, as before refining existed.
    log(`${issue.id}: refine output did not parse (${p.why}); building the issue as written`);
    await client.comment(
      issue.id,
      `${refineHead(r)}: the output did not parse (${p.why}), so keel builds the issue as written.\n\n${trim(r.output, 1500) ?? ''}`,
    );
    return { issue };
  }
  if (p.kind === 'human') {
    await client.comment(
      issue.id,
      `${refineHead(r)}: this issue needs your answer before it can be built:\n\n**${p.question}**\n\nAnswer in the description (or add a \`keel\` block with Requirements and Acceptance), then retry with \`keel poll --issue ${issue.id}\`.`,
    );
    return { outcome: { outcome: 'needsHuman', issue: issue.id, question: p.question, detail: { question: p.question } } };
  }
  if (p.kind === 'done') {
    const done = verifyDone({ repo, base, config, reason: `already satisfied: ${p.evidence}` });
    if (done.ok) {
      await closeDone(
        client,
        issue.id,
        `${refineHead(r)}: already done, closed without a build. Evidence: ${done.evidence.join('; ')}; checks green on base ${done.baseSha.slice(0, 12)}: ${done.checks.join(', ') || '(none configured)'}.`,
      );
      return { outcome: { outcome: 'alreadyDone', issue: issue.id } };
    }
    await client.comment(
      issue.id,
      `${refineHead(r)}: says already done (${p.evidence}), but the evidence did not hold: ${done.why}. Building the issue as written.`,
    );
    return { issue };
  }
  if (p.kind === 'split') {
    const children = [];
    try {
      for (const c of p.cards) {
        const fields = {
          title: c.title,
          description: `Split by keel from ${issue.id}.\n\n${c.body}\n`,
          priority: issue.priority, // Linear's 0 (no priority) included (REQ-LINEAR-33)
          blockedBy: children.length ? [children.at(-1)] : [],
          parent: issue.id,
        };
        children.push(await client.createIssue(issue.id, fields, project));
      }
      await client.comment(
        issue.id,
        `${refineHead(r)}: too big for one build; split into ${children.join(', ')}. They build in that order; this issue builds nothing itself.`,
      );
    } catch (e) {
      // Recorded before the error goes on, so the next poll does not split the issue again (REQ-LINEAR-33). With no
      // child filed for lack of network, nothing happened: the next poll refines the issue again (REQ-LINEAR-40).
      if (children.length || !networkFailure(e))
        recordPollAttempt(repo, { issue: issue.id, outcome: 'split', detail: { children, error: e.message } });
      throw e;
    }
    return { outcome: { outcome: 'split', issue: issue.id, children, detail: { children } } };
  }
  const description = `${REFINED_HEADING}\n\n${p.body}\n\n## Original description\n\n${issue.description ?? ''}`;
  await client.setDescription(issue.id, description);
  // The refined card may name paths the original did not: it waits for an open branch on them (REQ-LEASE-3).
  const held = cardLease(repo, base, cardFromIssue({ ...issue, description }), log);
  await client.comment(
    issue.id,
    `keel: refined this issue before building (refine turn on tier ${r.tier}: ${why}). The card is now at the top of the description:\n\n${p.body}`,
  );
  recordPollAttempt(repo, { issue: issue.id, outcome: 'refined', detail: { why } });
  if (held.length) {
    log(`${issue.id} waits for path lease: ${describeConflicts(held)}`);
    return { outcome: { outcome: 'leased', issue: issue.id } };
  }
  return { issue: { ...issue, description } };
}

/**
 * One issue → (refine) → card → run → report cycle (REQ-LINEAR-4, -5, -32). `runFn` defaults to `run` from run.js and
 * `refineFn` to the refine turn; tests inject fakes so no live worker or gate runs.
 */
async function runOne({ repo, base, pr, merge, log, config, client, issue: picked, project, runFn, refineFn, reserved }) {
  const step = await refineStep({ repo, base, config, client, issue: picked, project, log, refineFn, reserved });
  if (step.outcome) return step.outcome;
  const { issue } = step;
  const card = cardFromIssue(issue);
  const result = runFn({ repo, card, config, base, pr, merge, reserved, log });
  // Found work is queued before any Linear call, so a Linear error cannot lose it (REQ-LINEAR-22).
  queueFollowUps(repo, issue.id, result.followUps, result.branch, result.pr?.ok ? result.pr.out.trim().split('\n').at(-1) : null);
  // Recorded before any Linear call too, so a later poll merges it whatever this report does (REQ-MERGE-1).
  if (merge && result.pass && result.pr?.ok && result.merge?.selfMerge)
    recordSelfMerge(repo, { issue: issue.id, pr: result.pr.out.trim().split('\n').at(-1), sha: result.receipt.head });
  try {
    return await reportRun({ repo, base, config, client, issue, result });
  } catch (e) {
    // The build ran and was paid for: record it, then fail visibly, so the next poll does not build it again
    // (REQ-LINEAR-6). A transient stop stays retryable (REQ-LINEAR-19).
    const outcome = TRANSIENT_STOPS.has(result.stopped) ? 'deferred' : 'reportFailed';
    recordPollAttempt(repo, { issue: issue.id, outcome, detail: e.message });
    const down = networkFailure(e);
    // Linear never heard of this build, and the issue state is unchanged: say which issue, so a human reports it (REQ-LINEAR-40).
    if (down)
      log(
        `${issue.id} built (branch ${result.branch}) but not reported to Linear: network unreachable (${down.host}: ${down.code}); recorded ${outcome}`,
      );
    throw e;
  }
}

/** Report one run's result to Linear (REQ-LINEAR-5, -13, -16, -18, -19); returns the poll outcome. */
async function reportRun({ repo, base, config, client, issue, result }) {
  // A run takes minutes; a human or another session may have closed the issue meanwhile. Never reopen it (REQ-LINEAR-16).
  if (['completed', 'canceled'].includes(await client.stateType(issue.id))) {
    await client.comment(
      issue.id,
      `keel: this issue was closed while keel ran, so its state is unchanged. Keel's ${result.pass ? 'passing' : 'unfinished'} branch \`${result.branch}\` is not needed; remove it with \`keel clean\`.`,
    );
    return { outcome: 'closedMeanwhile', issue: issue.id, result };
  }
  // A pass without its PR is not done: say why and leave the issue where it is (REQ-LINEAR-18).
  if (result.pass && result.pr && !result.pr.ok) {
    await client.comment(
      issue.id,
      `keel: passed on tier ${result.tier}, attempt ${result.attempt}, but the PR step failed, so the issue stays open.\n\n${trim(result.pr.out, 2000)}\n\nThe certified branch \`${result.branch}\` is in ${result.worktree}; push it and open the PR, or retry with \`keel poll --issue ${issue.id}\`.`,
    );
    return { outcome: 'prFailed', issue: issue.id, result };
  }
  if (result.pass && result.merge?.state === 'auto') {
    await client.comment(
      issue.id,
      `keel: passed on tier ${result.tier}, attempt ${result.attempt}, tested and reviewed. PR: ${result.pr.out}\nauto-merge is on: GitHub merges it after the required checks, and \`Closes ${issue.id}\` closes this issue.`,
    );
    await client.review(issue.id);
    return { outcome: 'autoMerge', issue: issue.id, result };
  }
  if (result.pass && result.pr?.ok && result.merge?.selfMerge) {
    await client.comment(
      issue.id,
      `keel: passed on tier ${result.tier}, attempt ${result.attempt}, tested and reviewed. PR: ${result.pr.out}\nGitHub auto-merge is unavailable (${result.merge.reason}), so keel poll --merge merges ${result.receipt.head} itself once every check on it passes, and \`Closes ${issue.id}\` closes this issue.`,
    );
    await client.review(issue.id);
    return { outcome: 'selfMerge', issue: issue.id, result };
  }
  if (result.pass && !result.needsReview) {
    await client.comment(issue.id, passedComment(result));
    await client.review(issue.id);
    return { outcome: 'inReview', issue: issue.id, result };
  }
  if (result.pass) {
    await client.comment(
      issue.id,
      `keel: passed on tier ${result.tier} but touches protected work — human review required. Branch: \`${result.branch}\`.`,
    );
    return { outcome: 'needsReview', issue: issue.id, result };
  }
  // A provider limit says nothing about the card: retry it on the next poll, not never (REQ-LINEAR-19).
  if (TRANSIENT_STOPS.has(result.stopped)) {
    // A build that passed every stage but the unavailable review is kept and gated again next time (REQ-RUN-24).
    if (!result.pendingReview && result.worktree) removeParkedWorktree({ repo, path: result.worktree, branch: result.branch });
    const kept = result.pendingReview
      ? ` The build passed every other stage and is kept at \`${result.branch}\`; the next poll reviews it.`
      : '';
    await client.comment(
      issue.id,
      `keel: deferred (${result.stopped}): a model provider was unavailable, so no verdict on this card. The next poll retries it.${kept}\n\n${trim(result.failure, 1000) ?? ''}`,
    );
    return { outcome: 'deferred', issue: issue.id, result };
  }
  if (result.stopped === 'config') {
    await client.comment(issue.id, result.failure);
    return { outcome: 'blocked', issue: issue.id, result };
  }
  if (result.stopped === 'blocked') {
    // A claim that the work is already done closes the issue once its evidence holds (REQ-LINEAR-30).
    const done = ALREADY_SATISFIED.test(result.failure ?? '') ? verifyDone({ repo, base, config, reason: result.failure }) : null;
    if (done?.ok) {
      await closeDone(client, issue.id, doneComment(done, result));
      return { outcome: 'alreadyDone', issue: issue.id, result };
    }
    const unproven = done ? `\n\nThe worker says the card is already satisfied, but the evidence did not hold: ${done.why}.` : '';
    await client.comment(issue.id, `${blockedComment(result)}${unproven}`);
    return { outcome: 'blocked', issue: issue.id, result };
  }
  await client.comment(issue.id, failedComment(result));
  return { outcome: 'failed', issue: issue.id, result };
}

/** REQ-LINEAR-9: the daily spend ceiling, checked before every issue and before an explicit --issue retry. */
function overBudget({ repo, config, log }) {
  if (config.dailyBudgetUsd === null) return null;
  const { usd, unpriced } = spentToday(readLedger(), resolve(repo));
  if (unpriced) log(`${unpriced} attempt(s) today have no cost data and are not counted against the ceiling`);
  if (!(usd >= config.dailyBudgetUsd)) return null;
  log(`daily budget reached: $${usd.toFixed(2)} spent of $${config.dailyBudgetUsd}`);
  return { outcome: 'budget', spent: usd };
}

/**
 * REQ-PLAN-3: the subscription plan windows, read before every issue. Returns `{ stop }` when every provider of the
 * ladder is over a `planLimits` window, else `{ reserved }`: the providers the run must skip.
 */
function planCheck({ config, log, planFn }) {
  if (!config.planLimits || !planFn) return { reserved: new Map() };
  const plan = planFn(config);
  savePlan(plan, stateDir()); // every gate of this poll's runs reads it for the review window (REQ-PLAN-5)
  log(`plan: ${planLine(plan)}`);
  const reserved = reservedProviders(plan, config.planLimits);
  const providers = new Set(config.tiers.map((t) => t.provider));
  if (!reserved.size || ![...providers].every((p) => reserved.has(p))) return { reserved };
  const reset = nextReset(plan, config.planLimits);
  log(`plan limit reached: ${[...reserved].map(([p, w]) => `${p} ${w}`).join('; ')}${reset ? `; next reset ${reset}` : ''}`);
  return { stop: { outcome: 'plan', reserved: Object.fromEntries(reserved) } };
}

/**
 * `keel poll --issue <ID>` (REQ-LINEAR-14): an explicit human retry of one open issue, even if a previous poll
 * decided it. The `no-keel` opt-out still wins, and an invalid card raises its reason instead of skipping.
 */
async function pollOne({ repo, project, client, config, base, pr, merge, log, runFn, refineFn, only, reserved, capacityFn }) {
  const issues = await client.listIssues(project);
  const issue = issues.find((i) => i.id === only);
  if (!issue || (issue.labels ?? []).some((l) => l.toLowerCase() === 'no-keel')) {
    log(`${only} is not an open, eligible issue in ${project}; nothing to run`);
    return [{ outcome: 'none' }];
  }
  const held = cardLease(repo, base, cardFromIssue(issue), log);
  if (held.length) {
    // An open branch changes the same files: building now would conflict with it (REQ-LEASE-3). Not an attempt.
    log(`${issue.id} waits for path lease: ${describeConflicts(held)}`);
    return [{ outcome: 'leased', issue: issue.id }];
  }
  const outcome = await runOne({ repo, base, pr, merge, log, config, client, issue, project, runFn, refineFn, reserved });
  // A refined card whose paths an open branch holds is not an attempt (REQ-LEASE-3).
  if (outcome.outcome === 'leased') return [outcome];
  // The outcome keeps its own detail (a NEEDS_HUMAN question, SPLIT child IDs, REQ-LINEAR-33); byHand marks the run.
  recordPollAttempt(repo, { issue: issue.id, outcome: outcome.outcome, detail: outcome.detail, byHand: true });
  return [outcome, ...filingFailed(await fileFollowUps({ repo, project, config, client, log, base, capacityFn }))];
}

const CLOSED = new Set(['completed', 'canceled']);

/**
 * Each issue with the open prerequisites its text names added to `blockedBy` (REQ-LINEAR-26), so it waits like a
 * `blocks` relation (REQ-LINEAR-20). An open issue in the list is open; any other is read once per poll. An identifier
 * Linear cannot read is logged and not waited on: the catch is REQ-LINEAR-26's, so a typo cannot hold an issue forever.
 */
async function withTextPrerequisites(issues, { client, log, states }) {
  const open = new Set(issues.map((i) => i.id));
  const out = [];
  for (const issue of issues) {
    const waits = [];
    for (const id of textPrerequisites(issue)) {
      if (open.has(id)) {
        waits.push(id);
        continue;
      }
      if (!states.has(id)) {
        try {
          states.set(id, { state: await client.stateType(id) });
        } catch (e) {
          if (networkFailure(e)) throw e; // no network is no typo: stop the poll (REQ-LINEAR-40)
          states.set(id, { error: e.message });
        }
      }
      const s = states.get(id);
      if (s.error) log(`prerequisite ${id} of ${issue.id} not read: ${s.error}`);
      else if (!CLOSED.has(s.state)) waits.push(id);
    }
    out.push(waits.length ? { ...issue, blockedBy: [...new Set([...(issue.blockedBy ?? []), ...waits])] } : issue);
  }
  return out;
}

/**
 * `--project` wins; otherwise the repo's own keel.json names its Linear project (REQ-LINEAR-10). A `--project`
 * that differs from that `linearProject` is a usage error: it would build another project's issues in this repo
 * (REQ-LINEAR-34).
 */
export function resolveProject(explicit, config, repo = '.') {
  const own = config.linearProject;
  if (explicit && own && explicit !== own)
    throw new UsageError(
      `--project ${JSON.stringify(explicit)} differs from "linearProject" ${JSON.stringify(own)} in the keel.json of ${repo}; run keel poll in that project's repo, or drop --project`,
    );
  const project = explicit ?? own;
  if (!project) throw new UsageError('poll needs --project <name> or "linearProject" in keel.json');
  return project;
}

/**
 * `keel poll` (REQ-LINEAR-1..8): pick up to `limit` issues not yet attempted for this repo, run each
 * through Keel, report the outcome back to Linear, and record every attempt so a later poll does not
 * repeat it. Returns one result per issue attempted this call, or `[{ outcome: 'none' }]` when no
 * eligible issue remains.
 */
export async function poll({
  repo,
  project,
  client,
  config,
  base = 'HEAD',
  pr = false,
  merge = false,
  log = () => {},
  runFn = run,
  // The refine turn belongs to a real run: a test that injects `runFn` injects `refineFn` too (REQ-LINEAR-32).
  refineFn = runFn === run ? refineIssue : null,
  // Plan windows are read for a real run only: a test that injects `runFn` injects `planFn` too (REQ-PLAN-3).
  planFn = runFn === run ? readPlan : null,
  // The workspace's issue count is read for a real run only: a test that injects `runFn` injects `capacityFn` too
  // (REQ-LINEAR-37).
  capacityFn = runFn === run ? () => client.capacity() : null,
  // Closed issues are archived through the Linear client (REQ-LINEAR-39); linearHttpClient always can. An in-memory
  // client without `archiveClosed` (a test fake of other behavior) archives nothing; tests of archiving inject `archiveFn`.
  archiveFn = client.archiveClosed ? () => client.archiveClosed(project) : null,
  limit = 1,
  issue: only = null,
  fileOnly = false,
}) {
  // A project that is not this repo's stops before Linear is read or a worktree made (REQ-LINEAR-34).
  resolveProject(project, config, repo);
  // File the queued follow-ups and stop: no issue is built, commented on, or recorded (REQ-LINEAR-31).
  // Closed issues stop counting toward Linear's limit before anything is filed (REQ-LINEAR-39).
  const archived = await archiveClosed(archiveFn, log);
  if (fileOnly) return [...archived, ...filingFailed(await fileFollowUps({ repo, project, config, client, log, base, capacityFn }))];
  const results = [...archived];
  const prereqStates = new Map(); // prerequisite states read this poll (REQ-LINEAR-26)
  const deferredNow = new Set(); // issues this poll deferred (REQ-LINEAR-19)
  const leasedNow = new Set(); // issues whose paths an open branch holds (REQ-LEASE-3)
  // Self-merges whose checks were pending at an earlier poll go first; none waits on CI here (REQ-MERGE-2).
  if (merge) results.push(...(await finishSelfMerges({ repo, config, client, log })));
  results.push(...filingFailed(await fileFollowUps({ repo, project, config, client, log, base, capacityFn }))); // what an earlier poll could not file
  await rebuildConflicts({ repo, client, log });
  if (only) {
    const budget = overBudget({ repo, config, log });
    const plan = budget ? {} : planCheck({ config, log, planFn });
    const stop = budget ?? plan.stop;
    return [
      ...results,
      ...(stop
        ? [stop]
        : await pollOne({
            repo,
            project,
            client,
            config,
            base,
            pr: pr || merge,
            merge,
            log,
            runFn,
            refineFn,
            only,
            reserved: plan.reserved,
            capacityFn,
          })),
    ];
  }
  for (let i = 0; i < limit; i++) {
    const budget = overBudget({ repo, config, log });
    const plan = budget ? {} : planCheck({ config, log, planFn });
    const stop = budget ?? plan.stop;
    if (stop) {
      results.push(stop);
      break;
    }
    const issues = await withTextPrerequisites(await client.listIssues(project), { client, log, states: prereqStates });
    const attempted = attemptedIssueIds(repo);
    // A notKeel issue that no longer reads as human work, as when a keel block was added, is picked again (REQ-LINEAR-25).
    const triaged = notKeelIssueIds(repo);
    for (const i of issues) if (triaged.has(i.id) && !notKeelReason(i)) attempted.delete(i.id);
    const skipped = new Map();
    const waits = new Map();
    const human = new Map();
    let issue;
    for (;;) {
      issue = pickIssue(
        issues,
        new Set([...attempted, ...deferredNow, ...leasedNow, ...human.keys()]),
        (id, reason) => skipped.set(id, reason),
        (id, blockers) => waits.set(id, blockers),
        (id, why) => human.set(id, why),
      );
      if (!issue) break;
      const held = cardLease(repo, base, cardFromIssue(issue), log);
      if (!held.length) break;
      // An open branch changes the same files: pass over this issue, unrecorded, until that branch merges (REQ-LEASE-3).
      log(`${issue.id} waits for path lease: ${describeConflicts(held)}`);
      leasedNow.add(issue.id);
    }
    for (const [id, blockers] of waits) log(`${id} waits for ${blockers.join(', ')}`);
    for (const [id, reason] of skipped) {
      await client.comment(id, `Skipped by keel poll: ${reason}`);
      recordPollAttempt(repo, { issue: id, outcome: 'skipped', detail: reason });
    }
    for (const [id, { category, match }] of human) {
      await client.comment(
        id,
        `keel: not picked: this issue reads as a ${category} ("${match}"), not a code task, so no model was paid to say so. To have Keel build it anyway, add a \`keel\` block (kind: …) to the description or run \`keel poll --issue ${id}\`.`,
      );
      recordPollAttempt(repo, { issue: id, outcome: 'notKeel', detail: { category, match } });
    }
    if (!issue) {
      results.push({ outcome: 'none' });
      break;
    }
    const outcome = await runOne({ repo, base, pr, merge, log, config, client, issue, project, runFn, refineFn, reserved: plan.reserved });
    // A refined card whose paths an open branch holds waits, unrecorded, like any leased issue (REQ-LEASE-3): it is
    // not an attempt, so it uses no `limit` slot and the poll picks the next issue.
    if (outcome.outcome === 'leased') {
      leasedNow.add(issue.id);
      i -= 1;
      continue;
    }
    recordPollAttempt(repo, { issue: issue.id, outcome: outcome.outcome, detail: outcome.detail });
    // A deferred issue is retried by the next poll, not again in this one: move on to other work (REQ-LINEAR-19).
    if (outcome.outcome === 'deferred') deferredNow.add(issue.id);
    results.push(outcome, ...filingFailed(await fileFollowUps({ repo, project, config, client, log, base, capacityFn })));
  }
  return results;
}
