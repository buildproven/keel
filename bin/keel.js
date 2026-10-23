#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { autoClean } from '../src/autoclean.js';
import { expectedBranch, listParkedWorktrees, removeParkedWorktree } from '../src/clean.js';
import { loadConfig, readTrustedCard } from '../src/config.js';
import { branchCard, defaultBase, findDefaultBase } from '../src/defaults.js';
import { doctor, keelGateRequired, linearDoctor, mergeReadiness, setupAdvice } from '../src/doctor.js';
import { git } from '../src/git.js';
import { dora, formatDora } from '../src/dora.js';
import { escapedDefects, formatEscaped } from '../src/escaped.js';
import { gate, stageLine } from '../src/gate.js';
import { fmtMs, formatSlowest, slowestChecks } from '../src/timing.js';
import { audit } from '../src/audit.js';
import { keelTest } from '../src/keel-test.js';
import { authorFamily, fallbackReviewers, family, label, reviewerFor, windowFallback } from '../src/review.js';
import { readPlan, savePlan } from '../src/plan.js';
import { spendFile, windowLine, windowLines, windowUse } from '../src/window.js';
import { writeProposedConfig } from '../src/init.js';
import { writePostDeployWorkflow } from '../src/post-deploy.js';
import { formatReport, readJsonl, readLedger, report, stateDir } from '../src/ledger.js';
import { GATE_CONTEXT, gateState, postGateStatus } from '../src/status.js';
import { cardLease, describeConflicts, overlapWarnings } from '../src/lease.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll, pollExitCode, resolveProject } from '../src/poll.js';
import {
  activeProjects,
  addProject,
  formatProjects,
  projectsFile,
  readProjects,
  removeProject,
  setActive,
  setPaused,
  writeProjects,
} from '../src/projects.js';
import { fileProposals, proposeCards, proposedTitles, writeProposals } from '../src/propose.js';
import { describeStop, run } from '../src/run.js';
import { sizeWarning, stackWarnings } from '../src/stack.js';
import { UsageError } from '../src/usage.js';
import { RECUR_DAYS, formatRecurring, readReceipts, recurring } from '../src/recur.js';
import { formatValue, inWindow, value } from '../src/value.js';

const USAGE = `keel — quality gate that picks the model

  keel --version                                              print the version

  keel init [--repo <dir>]                                   detect the project, propose keel.json
  keel gate [--base <ref>] [--card <card.md>] [--author <family>] [--status] [--wait-review <h>] [--repo <dir>]
                                                               verify committed HEAD against base (default: origin's default
                                                               branch); without --card, a size-S card from the commit types;
                                                               the reviewer is of another family than --author (default:
                                                               KEEL_AUTHOR, else claude inside Claude Code); --status posts
                                                               the keel/gate commit status on HEAD (push it first);
                                                               --wait-review <hours>: when every reviewer is out, wait up
                                                               to that long for the named reset, then review again
  keel run <card.md | ISSUE-ID> [--base <ref>] [--repo <dir>] [--pr | --merge]
                                                               build a card: cheapest tier first, escalate on gate failure;
                                                               an issue ID builds that Linear issue (as poll --issue);
                                                               --merge also enables GitHub auto-merge of the certified SHA
  keel poll [--project <name>] [--base <ref>] [--repo <dir>] [--pr | --merge] [--limit N | --issue <ID> | --file-only]
            [--projects] [--propose]
                                                               pick, build, and report on the next N Linear issues (needs LINEAR_API_KEY);
                                                               --file-only files queued follow-ups and builds nothing;
                                                               --projects: one pass over each active project in your
                                                               project list (keel projects); --propose: when nothing is
                                                               eligible, draft cards (keel propose --file)
  keel projects [add <dir> [--rank N] | remove <dir> | pause <dir> | resume <dir> | active <N|all>]
                                                               the ranked list of repos keel works on; only the top N
                                                               unpaused ones are active (KEEL_PROJECTS_FILE, else
                                                               ~/.config/keel/projects.json)
  keel propose [--repo <dir>] [--base <ref>] [--focus <text>] [--file]
                                                               one read-only model turn: what is most worth building next,
                                                               written as up to proposeMax cards; card files to run with
                                                               keel run, or with --file Linear issues that wait for your
                                                               approval
  keel doctor [--repo <dir>] [--base <ref>]                  run the configured checks on a clean checkout of base; find red ones before a card does
  keel report [--escaped] [--dora] [--value [--days N]] [--recur]
                                                               ledger summary; --escaped lists fix: commits on files of merged
                                                               Keel changes; --dora prints DORA metrics per repo (30 days);
                                                               --value: finished cards, human touch rate, cost, later fixes,
                                                               all over the last N days (default 30); --recur: failure
                                                               classes that recur across gates in the last 14 days, to
                                                               prevent at their source
  keel audit [--limit N] [--repo <dir>]                      review PRs merged in the last 30 days (up to N, default
                                                               500) that only a fallback reviewer saw, with the reviewer
                                                               that was out; findings join the found-work queue under the
                                                               issue the PR closes
  keel test [--repo <dir>]                                   run testCommand in the working tree inside a machine-wide gate
                                                               slot; exits with its exit code
  keel clean [--force | --auto]                               list parked worktrees; --force removes the clean ones;
                                                              --auto removes the finished ones (also before every run and poll)`;

const usageFailure = (reason) => {
  process.stderr.write(`keel: ${reason}\n${USAGE}\n`);
  process.exitCode = 2;
};

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      card: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'boolean' },
      merge: { type: 'boolean' },
      force: { type: 'boolean' },
      auto: { type: 'boolean' },
      json: { type: 'boolean' },
      escaped: { type: 'boolean' },
      dora: { type: 'boolean' },
      recur: { type: 'boolean' },
      value: { type: 'boolean' },
      days: { type: 'string' },
      project: { type: 'string' },
      limit: { type: 'string' },
      issue: { type: 'string' },
      'file-only': { type: 'boolean' },
      projects: { type: 'boolean' },
      propose: { type: 'boolean' },
      rank: { type: 'string' },
      focus: { type: 'string' },
      file: { type: 'boolean' },
      author: { type: 'string' },
      status: { type: 'boolean' },
      'wait-review': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (e) {
  if (!String(e?.code).startsWith('ERR_PARSE_ARGS')) throw e;
  usageFailure(e.message.split('\n')[0].replace(/\. To specify.*/, ''));
  process.exit(2);
}
const { values, positionals } = parsed;
const [command, arg] = positionals;
const repo = resolve(values.repo ?? '.');
const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch (e) {
    if (e.code === 'ENOENT') return false; // a missing --repo is a usage error (REQ-CLI-2)
    throw e;
  }
};
const log = (m) => process.stderr.write(`keel: ${m}\n`);
/** `--limit` for poll and audit (REQ-LINEAR-8, REQ-CLI-11): a positive integer, else a usage error, never a silent no-op. */
const limitOption = (value, fallback) => {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
  return limit;
};

if (values.version && command) {
  // `-v` is not "verbose": with a command it must never stand in for the command (REQ-CLI-5).
  usageFailure(`--version takes no command (got "${command}")`);
} else if (values.version) {
  // The installed package's own version (REQ-CLI-5).
  process.stdout.write(`${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`);
} else if (values.help || !command) {
  process.stdout.write(`${USAGE}\n`);
} else {
  // An issue ID that is not a file builds that Linear issue (REQ-CLI-8).
  const isIssueRun = command === 'run' && /^[A-Z]+-[0-9]+$/.test(arg ?? '') && !existsSync(arg);
  try {
    if (['init', 'gate', 'run', 'poll', 'doctor', 'audit', 'test', 'propose'].includes(command) && !isDirectory(repo)) {
      throw new UsageError(`--repo ${repo} is not a directory`);
    }
    if (values.author !== undefined && command !== 'gate') throw new UsageError('--author is an option of gate only');
    if (values.status && command !== 'gate') throw new UsageError('--status is an option of gate only');
    if (values['wait-review'] !== undefined && command !== 'gate') throw new UsageError('--wait-review is an option of gate only');
    if (values.rank !== undefined && !(command === 'projects' && arg === 'add'))
      throw new UsageError('--rank is an option of projects add only');
    if ((values.focus !== undefined || values.file) && command !== 'propose')
      throw new UsageError('--focus and --file are options of propose only');
    if ((values.projects || values.propose) && command !== 'poll')
      throw new UsageError('--projects and --propose are options of poll only');
    if (values.days !== undefined && !(command === 'report' && values.value))
      throw new UsageError('--days is an option of report --value only');
    const waitReviewHours = values['wait-review'] === undefined ? 0 : Number(values['wait-review']);
    if (!(waitReviewHours >= 0) || (values['wait-review'] !== undefined && !(waitReviewHours > 0)))
      throw new UsageError('--wait-review must be a positive number of hours');
    if (command === 'init') {
      const result = writeProposedConfig(repo);
      if (!result.written) log(`keel.json already exists at ${result.path}; not overwritten`);
      else log(`wrote ${result.path} — review it, then commit it before running keel gate/run`);
      const workflow = writePostDeployWorkflow(repo);
      if (workflow.written)
        log(
          `wrote ${workflow.path} — set the VERCEL_TOKEN secret, the VERCEL_ORG_ID and VERCEL_PROJECT_ID variables, and "smoke" in keel.json`,
        );
    } else if (command === 'gate') {
      const base = values.base ?? defaultBase(repo);
      if (!values.base) log(`base ${base}`);
      // Rules come from the base commit, never from the change under test (REQ-CFG-1).
      const config = loadConfig(repo, base);
      let card;
      if (values.card) card = readTrustedCard(repo, base, values.card);
      else {
        card = branchCard(repo, base);
        log(`no card — ${card.id}: kind ${card.kind}, size S from commit types; pass --card to set scope, size, or held-out tests`);
      }
      // Stacked branches and oversized diffs multiply review rounds and merge conflicts; warn, never block (REQ-GATE-30).
      const size = sizeWarning(repo, base, 'HEAD', card, config);
      // Parallel branches on the same files conflict at merge and gate again (REQ-LEASE-1); warn, never block.
      for (const w of [...stackWarnings(repo, base), ...(size ? [size] : []), ...overlapWarnings(repo, base, log)]) log(`WARN ${w}`);
      // The reviewer is of another family than whoever wrote the change (REQ-CLI-9, REQ-GATE-21).
      const author = authorFamily(values.author, process.env);
      const reviewer = reviewerFor(config, author ? { family: author } : null);
      if (config.review) log(`reviewer ${reviewer ? `${reviewer.provider}/${reviewer.model}` : 'none'} (author ${author ?? 'unknown'})`);
      // A fresh reading of the plan windows, so the review window below uses the provider's own meter (REQ-PLAN-5).
      if (config.review && reviewer && config.tiers.some((t) => t.provider === 'claude' || t.provider === 'codex'))
        savePlan(readPlan(config), stateDir());
      const window = config.review && reviewer ? windowUse(spendFile(), family(reviewer), config.reviewWindows) : null;
      if (window) {
        const first = windowFallback(config, reviewer, spendFile());
        const why = !config.reviewFallback
          ? 'reviewFallback is off'
          : fallbackReviewers(config, reviewer).length
            ? 'no fallback has room'
            : 'no fallback reviewer';
        log(windowLine(window, { first: first && label(first), reviewer: label(reviewer), why }));
      }
      const receipt = gate({
        repo,
        base,
        card,
        config,
        receiptDir: join(stateDir(), 'receipts'),
        cacheDir: join(stateDir(), 'cache'),
        reviewer,
        spendFile: spendFile(),
        slotDir: join(stateDir(), 'locks'), // REQ-GATE-29
        waitReviewHours, // REQ-GATE-28
        log,
      });
      for (const r of receipt.results) log(stageLine(r));
      if (receipt.timing) log(receipt.timing); // REQ-GATE-45
      for (const line of receipt.improve ?? []) log(line); // REQ-GATE-46
      if (!receipt.pass) for (const r of receipt.results.filter((x) => !x.pass && x.output)) process.stderr.write(`${r.output}\n`);
      if (values.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      process.exitCode = receipt.pass ? 0 : 1;
      if (values.status) {
        // The required keel/gate status on the gated SHA (REQ-CLI-10); the commit must already be on GitHub.
        const status = postGateStatus(repo, receipt, config);
        log(
          status.ok
            ? `status ${GATE_CONTEXT} ${gateState(receipt)} on ${receipt.head}`
            : `status ${GATE_CONTEXT} not posted: ${status.out}`,
        );
        if (!status.ok) process.exitCode = 1;
      }
    } else if (command === 'run' && !isIssueRun) {
      if (!arg) throw new UsageError('run needs a card file or an issue ID');
      autoClean({ log }); // REQ-CLEAN-3: each run starts by removing finished worktrees
      const base = values.base ?? 'HEAD';
      const card = readTrustedCard(repo, base, arg);
      const held = cardLease(repo, base, card, log);
      if (held.length) {
        // Another open branch changes the card's files; building now would conflict at merge (REQ-LEASE-2).
        log(`path lease: ${card.id} overlaps ${describeConflicts(held)}; merge or close it first, or narrow the card's paths`);
        process.exitCode = 3;
      } else {
        const result = run({ repo, card, config: loadConfig(repo, base), base, pr: values.pr, merge: values.merge, log });
        log(
          result.pass
            ? `PASS tier ${result.tier}, attempt ${result.attempt}, branch ${result.branch}${result.needsReview ? ' — human review required' : ''}`
            : describeStop(result),
        );
        if (result.pr) log(result.pr.ok ? `PR ${result.pr.out}` : `PR failed:\n${result.pr.out}`);
        process.exitCode = result.pass && (!result.pr || result.pr.ok) && result.merge?.state !== 'failed' ? 0 : 1;
      }
    } else if (command === 'poll' && values.projects) {
      // One pass over the active projects, in rank order (REQ-MULTI-5); each keeps its own keel.json and Linear project.
      for (const flag of ['repo', 'project', 'issue', 'base', 'file-only'])
        if (values[flag] !== undefined) throw new UsageError(`--${flag} cannot be combined with --projects`);
      const file = projectsFile();
      const active = activeProjects(readProjects(file));
      if (!active.length) throw new UsageError(`no active projects in ${file}; add one with keel projects add <dir>`);
      autoClean({ log }); // REQ-CLEAN-3
      const results = [];
      for (const [i, p] of active.entries()) {
        log(`project ${i + 1}/${active.length}: ${p.repo}`);
        try {
          if (!isDirectory(p.repo)) throw new UsageError(`${p.repo} is not a directory`);
          const base = p.base ?? 'HEAD';
          const config = loadConfig(p.repo, base);
          const rows = await poll({
            repo: p.repo,
            project: resolveProject(undefined, config, p.repo),
            client: linearHttpClient(),
            config,
            base,
            pr: values.pr,
            merge: values.merge,
            log,
            limit: p.limit ?? limitOption(values.limit, 1),
            propose: Boolean(values.propose),
          });
          for (const r of rows) log(`${p.repo}: ${r.issue ?? '(none)'}: ${r.outcome}`);
          results.push(...rows);
        } catch (e) {
          // REQ-MULTI-5: one project's error is reported with its repo and fails the pass, and the next project still runs.
          log(`${p.repo}: ${e.message}`);
          results.push({ outcome: 'failed', repo: p.repo, detail: e.message });
        }
      }
      process.exitCode = pollExitCode(results);
    } else if (command === 'poll' || isIssueRun) {
      // `keel run <ISSUE-ID>` is `keel poll --issue <ISSUE-ID>` (REQ-CLI-8).
      if (isIssueRun) values.issue = arg;
      if (values['file-only'] && values.issue !== undefined) throw new UsageError('--file-only cannot be combined with --issue');
      autoClean({ log }); // REQ-CLEAN-3: each poll pass starts by removing finished worktrees
      const base = values.base ?? 'HEAD';
      const limit = limitOption(values.limit, 1);
      const config = loadConfig(repo, base);
      const project = resolveProject(values.project, config, repo);
      if (values.issue !== undefined && !/^[A-Z]+-[0-9]+$/.test(values.issue))
        throw new UsageError(`--issue ${JSON.stringify(values.issue)} must look like BUI-123`);
      const results = await poll({
        repo,
        project,
        client: linearHttpClient(),
        config,
        base,
        pr: values.pr,
        merge: values.merge,
        log,
        limit,
        issue: values.issue ?? null,
        fileOnly: Boolean(values['file-only']),
        propose: Boolean(values.propose),
      });
      for (const r of results) log(`${r.issue ?? '(none)'}: ${r.outcome}`);
      process.exitCode = pollExitCode(results);
    } else if (command === 'projects') {
      // The ranked project list (REQ-MULTI-3, -4): no subcommand lists it; a change writes the file and lists it.
      const file = projectsFile();
      const data = readProjects(file);
      const target = positionals[2];
      const needsDir = ['add', 'remove', 'pause', 'resume'];
      if (needsDir.includes(arg) && !target) throw new UsageError(`projects ${arg} needs a directory`);
      const rank = values.rank === undefined ? null : Number(values.rank);
      const changed =
        arg === undefined || arg === 'list'
          ? null
          : arg === 'add'
            ? addProject(data, target, rank)
            : arg === 'remove'
              ? removeProject(data, target)
              : arg === 'pause' || arg === 'resume'
                ? setPaused(data, target, arg === 'pause')
                : arg === 'active'
                  ? setActive(data, target)
                  : null;
      if (changed === null && arg !== undefined && arg !== 'list') throw new UsageError(`unknown projects subcommand "${arg}"`);
      if (changed) writeProjects(file, changed);
      process.stdout.write(`${formatProjects(changed ?? data, file)}\n`);
    } else if (command === 'propose') {
      // What to build next, as cards (REQ-PROPOSE-1..6): files to run, or Linear issues that wait for approval.
      if (arg !== undefined) throw new UsageError('propose takes no argument');
      const base = values.base ?? 'HEAD';
      const config = loadConfig(repo, base);
      const client = values.file ? linearHttpClient() : null;
      const project = values.file ? resolveProject(undefined, config, repo) : null;
      const open = client ? (await client.listIssues(project, { closedWithinDays: 30 })).map((i) => i.title) : proposedTitles(repo);
      const r = proposeCards({ repo, base, config, open, focus: values.focus ?? null, log });
      const p = r.parsed;
      if (p.kind === 'unparsed') {
        log(`propose: ${p.why}`);
        if (r.output) process.stderr.write(`${r.output.slice(-2000)}\n`);
        process.exitCode = r.status === 'quota' ? 3 : 1;
      } else if (p.kind === 'none') log(`propose: nothing worth a card now: ${p.why}`);
      else {
        for (const d of p.dropped) log(`propose: dropped "${d.title}": ${d.why}`);
        if (client) {
          const ids = await fileProposals({ client, project, config, cards: p.cards });
          log(
            `propose: filed ${ids.join(', ') || 'nothing'} in ${project}${config.proposeApproval && ids.length ? '; each waits for your approval: delete its first line' : ''}`,
          );
        } else
          for (const [i, path] of writeProposals(repo, p.cards).entries())
            process.stdout.write(`${path}  ${p.cards[i].title}\n  keel run ${path} --repo ${repo} --pr\n`);
      }
    } else if (command === 'doctor') {
      const base = values.base ?? 'HEAD';
      const rows = doctor({ repo, base, config: loadConfig(repo, base) });
      for (const r of rows) {
        if (r.kind === 'advice') {
          log(`WARN ${r.output}`); // REQ-CLI-13: never fails the doctor
          continue;
        }
        const took = typeof r.ms === 'number' ? ` (${fmtMs(r.ms)})` : '';
        const state =
          r.kind === 'acceptance'
            ? `INFO acceptance ${r.name} (${r.pass ? 'green' : 'red'})${took}`
            : `${r.pass ? 'PASS' : 'FAIL'} ${r.kind} ${r.name}${took}`;
        log(state);
        if (!r.pass && r.kind !== 'acceptance' && r.output) process.stderr.write(`${r.output}\n`);
      }
      process.exitCode = rows.every((r) => r.pass || r.kind === 'acceptance') ? 0 : 1;
      const config = loadConfig(repo, base);
      for (const w of setupAdvice(config)) log(`WARN ${w}`); // REQ-CLI-15: never fails the doctor
      // Merges go to the default branch, so read its protection, not the checked-out branch's (REQ-CLI-4).
      const target = values.base ?? findDefaultBase(repo) ?? 'HEAD';
      const branch = target === 'HEAD' ? git(['symbolic-ref', '--short', 'HEAD'], repo).trim() : target.replace(/^origin\//, '');
      const ready = mergeReadiness({ repo, branch, config });
      log(`INFO merge-ready ${ready.ready ? 'yes' : `no (${ready.reason})`}`);
      for (const line of windowLines(config, spendFile())) log(`INFO ${line}`); // REQ-GATE-27
      log(
        `INFO ${GATE_CONTEXT} required ${keelGateRequired(repo, branch) ? 'yes' : `no (a push after the gate can merge ungated; require ${GATE_CONTEXT} on ${branch})`}`,
      );
      // Room for new Linear issues, when this machine polls Linear (REQ-CLI-16).
      if (await linearDoctor({ env: process.env, client: linearHttpClient, log })) process.exitCode = 1;
    } else if (command === 'audit') {
      // Cross-family re-review of merges only a fallback reviewer saw (REQ-CLI-11).
      const limit = limitOption(values.limit, 500);
      const results = audit({ repo, config: loadConfig(repo, 'HEAD'), limit });
      if (!results.length) log('audit: nothing to audit');
      for (const r of results) {
        const at = `audit #${r.pr} ${r.sha.slice(0, 7)}`;
        if (r.outcome === 'unavailable') log(`${at}: unavailable (${r.reviewer}); the next audit retries`);
        else if (r.outcome === 'no-reviewer') log(`${at}: no tier is ${r.from}; not audited`);
        else {
          // Notes below reviewBlock are shown, never filed (REQ-CLI-17).
          const notes = r.findings.length - r.queued;
          const unfiled = notes ? `; ${notes} note(s) below reviewBlock, not filed` : '';
          if (r.outcome === 'pass') log(`${at}: pass by ${r.reviewer}${unfiled}`);
          else
            log(
              `${at}: ${r.queued} finding(s) by ${r.reviewer}; ${r.source ? `queued under ${r.source}` : 'queued with no source (no Closes ID); poll files it in its project'}${unfiled}`,
            );
          for (const f of r.findings) log(`  ${f.severity} ${f.path}:${f.line} ${f.text}`);
        }
      }
      process.exitCode = results.some((r) => r.outcome === 'findings') ? 1 : results.some((r) => r.outcome === 'unavailable') ? 3 : 0;
    } else if (command === 'test') {
      // Builders run their tests through a gate slot, so every test run on the machine queues (REQ-SLOT-2).
      if (arg !== undefined) throw new UsageError('test takes no argument; it runs testCommand from keel.json at HEAD');
      process.exitCode = keelTest({ repo, config: loadConfig(repo, 'HEAD'), slotDir: join(stateDir(), 'locks'), log });
    } else if (command === 'clean' && values.auto) {
      if (values.force) throw new UsageError('clean takes --force or --auto, not both');
      autoClean({ log });
    } else if (command === 'clean') {
      const worktrees = listParkedWorktrees();
      if (!worktrees.length) log('no parked worktrees');
      for (const w of worktrees) {
        if (!values.force) {
          log(`${w.path} (${w.repo}, ${w.branch ?? 'detached'}, ${w.clean ? 'clean' : 'dirty'})`);
          continue;
        }
        if (!w.own) {
          log(`skipped (on ${w.branch ?? 'a detached HEAD'}, not ${expectedBranch(w.path)}): ${w.path}`);
          continue;
        }
        if (!w.clean) {
          log(`skipped (dirty): ${w.path}`);
          continue;
        }
        removeParkedWorktree(w);
        log(`removed: ${w.path}`);
      }
    } else if (command === 'report') {
      // With --value every line uses one window, --days N or 30 (REQ-LED-19); without it the summary is all-time.
      const windowDays = values.days === undefined ? 30 : Number(values.days);
      if (values.days !== undefined && !/^[1-9][0-9]*$/.test(values.days)) throw new UsageError('--days must be a positive integer');
      const now = new Date();
      const windowed = (rows) => (values.value ? inWindow(rows, windowDays, now) : rows);
      if (values.value)
        process.stdout.write(
          `Window: last ${windowDays} days (since ${new Date(now.getTime() - windowDays * 86400000).toISOString().slice(0, 10)})\n`,
        );
      process.stdout.write(`${formatReport(report(windowed(readLedger())))}\n`);
      process.stdout.write(`${formatSlowest(slowestChecks(windowed(readJsonl(join(stateDir(), 'gate-times.jsonl')))))}\n`); // REQ-LED-18
      if (values.escaped) process.stdout.write(`${formatEscaped(escapedDefects(readLedger()))}\n`);
      if (values.dora) process.stdout.write(`${formatDora(dora(readLedger()))}\n`);
      if (values.value) process.stdout.write(`${formatValue(value(readLedger(), { windowDays, now }))}\n`);
      if (values.recur) {
        const rows = recurring(readReceipts(join(stateDir(), 'receipts')), { days: RECUR_DAYS, now }); // REQ-LED-20
        process.stdout.write(`${formatRecurring(rows, RECUR_DAYS)}\n`);
      }
    } else {
      throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    usageFailure(e.message);
  }
}
