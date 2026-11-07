# Daily simulation loop implementation plan

> Execute within the existing isolated worktree using parallel bounded tasks, regression tests and independent review.

**Goal:** Make today's report, strategy management and channel execution a connected path that explains the next action on screen.

**Architecture:** Reuse exact-source draft import, revision-bound confirmation and authoritative paper execution. Add guarded draft deletion/current-strategy removal; keep immutable report and execution history.

**Tech stack:** React, TanStack Query, NestJS, Drizzle/PostgreSQL, Node test runner.

- [x] Report task: reproduce multi-step import, then change `ReportExecutionPlan` to import exact section and navigate to returned draft; fix generic source success destination; test repeat/error/no model/no apply. Add constrained system observation fallback for absent daily plan with tests.
- [x] Management task: reproduce missing deletion and needless reinterpretation; add owner/revision-bound draft deletion plus atomic current removal, migration, API and editor/section controls. Test stale revisions, owner isolation, replay, historical preservation and execution fences.
- [x] Channel task: reproduce complete-fill silence in durable integration test; publish visible factual messages for all actual fills without duplicate messages or invented executions.
- [x] Page task: test imported strategy ID survives first account setup; mount management on `/paper` once policy exists; add concise next-step guidance and links; retain Today compatibility. Hide setup-detail complexity until needed.
- [x] Integration: run all required local suites against disposable database; inspect browser desktop/mobile paths; repair discovered issues; update bilingual docs, architecture, skill references and metadata; independent review; prepare PR with validation evidence.

## Validation evidence

- Server: 904 passed, zero skipped, using a disposable PostgreSQL cluster with all database test variables set.
- Client: 342 passed, zero skipped. Native agent suite: 175 passed; one POSIX-only process cancellation case skipped on Windows.
- Lint/typecheck, production web build, context helper tests (15), context validation and diff whitespace checks passed. Context validation reports the expected review-required warning for changed entrypoints against the recorded baseline.
- Browser acceptance used fictional data in a separate UI database: report copy, first account setup with draft preservation, explicit activation, editing/saving, stopping/removing the current strategy, retained confirmation history and draft deletion. Checked the compact review dialog at 390 × 844 without horizontal overflow.
- Independent review found and resolved misleading execution status for observation-only, future, expired and unknown-heartbeat states; no remaining P1/P2 findings.
- Architecture diagrams 1–5 were reviewed. Updated report/strategy/channel flows and affected contributor references; unrelated startup and update boundaries remain unchanged.

Required GitHub checks run on the PR. The live installation and the globally installed contributor skill remain unchanged; deployment and post-merge skill synchronization are separate actions.
