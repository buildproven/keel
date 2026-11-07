---
name: cards
description: 'Turn a spec, PRD, feature idea, or `make`/`ideas` output into small Linear cards that Keel can build unattended: S/M vertical slices, EARS acceptance criteria, Bug/Feature labels, estimates, a `keel` block, dependencies, and `no-keel` on human work. Use when the user asks to plan, break down, decompose, or write issues/cards/tickets for something to build, or to "feed Keel".'
---

# Cards

Keel builds what the card says and nothing else. Card quality is the main cause of
wasted nightly runs (cards already satisfied, human work, impossible as written), so
this skill writes cards a model can finish and a test can prove. It writes Linear
issues; `keel poll` (nightly, or `keel poll --issue <ID> --merge`) builds them.

## Inputs

- The source: a spec or PRD file, a feature description, or the output of `make` or
  `ideas build`. Read it in full.
- The target repo. Read its `keel.json` (`linearProject`, `checks`, `protected`),
  `docs/DESIGN.md` or README, and the code the change touches.

## Steps

1. **Slice vertically.** One observable behavior per card, end to end, small enough
   to build and merge alone (DORA: small batches). Estimate 1–5 only (Keel size S/M).
   Split anything bigger. Order the slices so each merge leaves the product working.
2. **Check each slice is not done already.** Search the code and run the relevant
   tests. Drop a satisfied slice; say why.
3. **Write each card** as a Linear issue in the repo's `linearProject`:
   - Title: the behavior, imperative, ≤ 70 characters.
   - Label: `Bug` (wrong behavior), `Feature` or `Improvement` (new behavior).
   - Estimate: 1–2 (S) or 3–5 (M).
   - Description:

     ~~~markdown
     <one to three lines of context: who needs this and why>

     ## Root cause

     <Bug only: why it happens, with file:line evidence>

     ## Prevention

     <Bug only: the test, check, `keel doctor` line, or skill rule that stops this class recurring>

     ## Requirements

     - REQ-<AREA>-<n>: When <trigger>, the <system> shall <observable response>.

     ## Acceptance

     - [ ] <how a test proves each requirement; name the interface: route, function, CLI, page>

     ```keel
     paths: <globs the change may touch>
     allowEdits: <only an existing test or locked file the card truly must change>
     ```
     ~~~

   Each `keel` line is `key: value` on one line; list globs comma-separated (`paths: src/a.js, test/**`). A YAML
   list (`- src/a.js` on its own line) is rejected and the card is skipped.

   Keep `Root cause` and `Prevention` as headings: a `Word:` line above the first heading is read as a card header.

   After filing each card, run `keel check-card <ID>` in the repo and fix the card until it passes (exit 0). It
   parses the card as `keel poll` does and lists each exact `paths` file that is not on the base and not marked new;
   mark a file the card creates `<path> (new)`. A card that fails it is deferred or skipped by `keel poll`, a night
   later (32 deferrals across 17 issues by 2026-11-07, BUI-1889).

   A card that only adds tests for existing behavior sets `kind: chore` in its `keel` block (such tests pass on the
   base, so a bug or feature card can never pass red proof) and says "put the new tests in a new test file": existing
   test files are locked, and a builder that edits them fails the gate (BUI-1137 lost two tiers that way).

4. **Mark human work `no-keel`.** Playtests, interviews, approvals, decisions,
   purchases, account or vendor setup, content to write, and anything a test cannot
   check. Write those as plain issues for the founder.
5. **Link order.** Use `blockedBy` for slices that depend on earlier ones.
6. **Report** the cards as a table: ID, title, size, depends on, `no-keel` or not.

## Rules

- A Bug card fixes the root cause, never a symptom, and its `Prevention` lands in the owning tool in the same card
  (or a linked one), so the class does not come back. No root cause yet: investigate first; do not file a guess.
- `keel report --recur` lists failure classes that recur across gates, with the previous window's count. Start a
  prevention card from its top class, and check that the count falls after the merge.
- Name behavior and interfaces; never prescribe the implementation.
- When `paths` names a file the card creates, mark it new: in the `paths` line (`paths: src/**, manifest.json (new)`)
  or in the card text ("the new file `manifest.json`", or `manifest.json` (new)). Never mark an `allowEdits` item new:
  `allowEdits` lists existing files only, and the card is rejected. `keel poll` defers a card whose exactly named path is missing on the base and not marked new
  (REQ-LINEAR-44), so an unmarked new file never builds (BUI-1787 and BUI-1788 waited a night that way).
- When a card adds or changes a `package.json` script, list `package.json` in `allowEdits`: Keel locks its scripts, and
  the build stops as blocked without it. Do not list `pyproject.toml` for a console script: only its tool sections are
  locked, and `allowEdits` would open them.
- When the repo has a generated traceability file (such as `docs/TRACEABILITY.md`) that a test keeps in step with
  the tests, add it to `paths`: a card that adds a test must regenerate it, or the build stops as blocked.
- Every requirement has an acceptance line a test can check. If you cannot write one,
  the card is not ready: ask, or mark it `no-keel`.
- Protected paths (auth, payments, migrations, infra) need a held-out-test-friendly
  card: exact inputs and outputs, because Keel auto-merges them only with passing
  held-out tests (DESIGN §9).
- Every card is held-out tested, so name the exact interface a test drives: the command, flag or env
  variable that sets each input (a probe command, a wait shortened by env), the exact output lines, and the exit
  status. A held-out author who must guess the interface writes tests no builder can pass: BUI-1893 failed all
  four tiers on 2026-11-07 because its card said "wait shortened by env" without naming the variable.
- No card larger than M. No card that only says "investigate" or "refactor everything".
- Facts about the market, prices, or vendors cite a source or say `[unverified]`.
