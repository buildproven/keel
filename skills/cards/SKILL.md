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

     ## Requirements

     - REQ-<AREA>-<n>: When <trigger>, the <system> shall <observable response>.

     ## Acceptance

     - [ ] <how a test proves each requirement; name the interface: route, function, CLI, page>

     ```keel
     paths: <globs the change may touch>
     allowEdits: <only an existing test or locked file the card truly must change>
     ```
     ~~~

   A card that only adds tests for existing behavior sets `kind: chore` in its `keel` block (such tests pass on the
   base, so a bug or feature card can never pass red proof) and says "put the new tests in a new test file": existing
   test files are locked, and a builder that edits them fails the gate (BUI-1137 lost two tiers that way).

4. **Mark human work `no-keel`.** Playtests, interviews, approvals, decisions,
   purchases, account or vendor setup, content to write, and anything a test cannot
   check. Write those as plain issues for the founder.
5. **Link order.** Use `blockedBy` for slices that depend on earlier ones.
6. **Report** the cards as a table: ID, title, size, depends on, `no-keel` or not.

## Rules

- Name behavior and interfaces; never prescribe the implementation.
- Every requirement has an acceptance line a test can check. If you cannot write one,
  the card is not ready: ask, or mark it `no-keel`.
- Protected paths (auth, payments, migrations, infra) need a held-out-test-friendly
  card: exact inputs and outputs, because Keel auto-merges them only with passing
  held-out tests (DESIGN §9).
- No card larger than M. No card that only says "investigate" or "refactor everything".
- Facts about the market, prices, or vendors cite a source or say `[unverified]`.
