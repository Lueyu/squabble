# Team automatic research and paper execution implementation plan

> **For agentic workers:** Use subagent-driven development; preserve exact request identities and existing authorization fences.

**Goal:** A newly created or unconfigured team can complete staffing, publication and paper-account setup from its overview, review a run agreement, research immediately at startup, then research after daily close and execute supported strategies automatically in paper trading.

**Architecture:** Reuse Teams publication/binding, roster identities, standing TeamRun agreements, Council research and the existing paper strategy scheduler. Add a frozen optional initial-run mode to agreement JSON; older agreements keep scheduled behavior. No second trading engine. Migration68 permits explicit unbounded cost reservations; existing positive values remain unchanged.

**Tech Stack:** React, TanStack Query, NestJS, Drizzle/PostgreSQL, existing Node/tsx behavioral and integration fixtures.

## Task 1: Recoverable overview setup

Files: `TeamWorkspacePage.tsx`, `TeamRunPanel.tsx`, `TeamRosterBinding.tsx`, lifecycle dialogs and new focused setup component under `client/src/features/teams/`.

- [x] Add failing React behavior coverage for a published unbound team and a template with unassigned seats: overview exposes working configuration/publication/account actions instead of a disabled dead end.
- [x] Reuse existing roster commands to apply suggested owned friends as a draft; preserve existing assignments and identify unavailable/missing seats. Publication remains the existing explicit preview/confirm.
- [x] Expose existing paper-account creation/binding and account-policy review from overview. Retain exact request keys on uncertain outcomes and never silently pick a personal account.
- [x] Route newly created teams to the setup overview and give clear state-specific next actions.

## Task 2: Review before starting

Files: `TeamRunPanel.tsx`, `guided-team-state.ts`, `team-run-review-flow.test.cjs`, novice recovery regressions.

- [x] Add failing tests proving the initial button only retrieves a preview and cannot confirm/start before actual account/members/limits are shown.
- [x] Separate preview from final confirmation. Freeze immediate-start selection and calculate per-run calls from blueprint requirements, with optional daily money caps and explicit null default money/period caps.
- [x] Prevent new setup from unknown run state, preserve exact preview/confirm/start identities after lost responses, and invalidate edited/stale previews.
- [x] Show startup research timing, daily cadence, account link, bounded budgets and actual cycle/strategy states in Chinese and English.

## Task 3: Exactly-once initial research

Files: `shared/team-run.interface.ts`, `team-run.rules.ts`, `team-run.scheduler.ts`, run rules/integration specs.

- [x] Add failing tests for explicit initial immediate mode, old scheduled default, duplicate ticks, restarts, pause/resume, current revision and existing cycle/date identity.
- [x] Freeze optional `initialRun: immediate|scheduled` in preview/confirmed configuration; legacy omission keeps scheduled behavior.
- [x] Reserve the initial cycle using existing transaction locks, budget checks, verified market-local date, durable cycle uniqueness and commission identities. Later cycles continue after-close scheduling. No paid retry on an unknown outcome.
- [x] Verify automatic delivery still installs only validated supported strategy output into the bound simulated account; existing paper scheduler checks actual trading session, quote freshness and risk before fills.

## Task 4: Creation defaults requested by the user

- [x] Every creation prepares a distinct paper account from real positions, with editable CNY10,000, USD10,000 and HKD10,000 virtual opening cash replacing real cash. Show the frozen snapshot before creation; preserve real ledger data.
- [x] Reuse exact durable quick-start identities. Lost responses, expired previews and changed real positions retain completed team/publication steps; new snapshots require visible review again.
- [x] Default research money and daily/monthly call caps to explicit null; retain a finite per-run call limit and editable daily money ceiling. Verify migration68 fresh/upgrade/replay and conservative accounting of earlier unknown reservations.

## Task 5: Validation and delivery

- [ ] Run focused red/green client and disposable-database TeamRun/Teams/paper execution tests, then required application checks and web build.
- [x] Review architecture diagrams and update affected bilingual docs and canonical contributor routing.
- [x] Independently review final diff and browser-test the flow with fictional data at desktop/mobile; personal instance is read-only during verification.
- [ ] Open PR, satisfy all required checks, merge and update the authorized local instance with matched backup/restore verification; do not start paid personal research as a smoke test.

Requested behavior is automatic research and paper execution. The setup offers immediate first research and daily after-close research; the confirmed selection determines the actual schedule. Account and explicit unbounded-or-limited budget remain visible in the confirmed agreement. The user separately authorized enabling the screenshot team with a new real-position/three-currency virtual account and no default team money cap; this is separate from fictional deployment smoke tests.
