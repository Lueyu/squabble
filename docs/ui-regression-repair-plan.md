# UI regression repair implementation plan

> **For agentic workers:** Use subagent-driven-development for independent implementation areas, then independent specification and code-quality reviews.

**Goal:** Restore recognizable animal identities, separate investment and holdings navigation, and complete the approved beginner journey without broken destinations or lost form state.

**Architecture:** Add animal identity metadata to the existing roster and freeze it into existing research/team snapshots. Repair navigation and UI composition using the current account, import, team and research APIs; retain their authorization and idempotency boundaries.

**Tech Stack:** React, TypeScript, existing AnimalAvatar SVGs, NestJS, PostgreSQL16, node:test, Playwright CLI.

**Design:** [股友身份与页面职责整改](ui-regression-repair-design.zh-CN.md) reflects the user's explicit corrective instruction and the previously approved onboarding design. [Validation](ui-regression-repair-validation.md) separates observed results from pending gates. Source review uses `261f07ce17b80fef7dfe525725a711e72b0f63de` plus this working tree; an unchecked combined task may contain implemented steps whose full verification is still pending.

## 1. Reproduce and record

- [x] Audit the current implementation against the approved design, previous commits and current route table.
- [x] Identify missing persisted avatar, missing holdings navigation, `/today` and commission-route dead links, misleading account names and incomplete guided recovery.
- [x] Capture browser baseline screenshots and console errors. Live baseline writes were blocked; interactive acceptance uses a loopback fictional HTTP gateway with no upstream forwarding.

## 2. Persist and display stock-friend identities

**Files:** `shared/agent-roster.interface.ts`, shared animal IDs as needed, `server/modules/agent-roster/`, `server/modules/council/council.roster.ts`, team snapshot/commission adapters, `scripts/db/66_*.sql`, schema and migration registry, `client/src/features/agent-roster/` and related tests.

- [x] Add regression cases for chosen-animal create/read/update, invalid IDs, avatar-only edits preserving capabilities/permissions, and frozen snapshot identity after later edits. Results are in the validation record.
- [x] Add the animal metadata and additive backfill, register the migration, update fresh schema, and verify migration replay. Focused backend suite82 passed; read-only fresh-schema comparison also matched.
- [x] Propagate animal metadata through new conversation and commission snapshots while preserving legacy fallbacks. Source paths and focused avatar DOM checks reviewed; transactional acceptance is recorded separately.
- [x] Add an animal picker and recognizable card identity using existing SVGs; expose working instructions as working instructions rather than a misleading description field. Focused avatar DOM suite:5 passed.
- [x] Carry UI language into recommended creation so persisted English agents use English templates. Source review confirms language in recommended input and saved template selection.
- [x] Run `npx tsx --tsconfig tsconfig.node.json --test server/modules/agent-roster/*.spec.ts server/modules/council/council.team.spec.ts` with an owned disposable database; no skipped integration cases count as passing. The expanded roster/Council/Teams command in the validation record passed82/82 with no skips.

## 3. Restore distinct investment and holdings destinations

**Files:** `client/src/features/navigation/`, `client/src/pages/Paper/SimulationAccountsPage.tsx`, investment/holdings page titles, `client/src/pages/Import/`, screenshot import component, corresponding client tests.

- [x] Test separate top-level investment and holdings navigation, mobile/search reachability, account-scoped returns and `/friends` return validation. Five daily entries now include holdings on mobile.
- [x] Restore `/holdings` as a primary root destination with a clear “持仓” title; keep investment overview at `/` and account-specific holdings links. Desktop and mobile visual route acceptance passed.
- [x] Call `/paper` “模拟账户”, add an explicit retained destination in search, and keep independent agents under `/friends`. Route catalog and affected page labels inspected.
- [x] Make import saving the primary action and continue to friends without starting research. Explicit research uses `/research/portfolio`. Browser CSV save/continuation passed with `analyze:false`.
- [x] Fix same-page unknown import outcomes: preserve batch/full payload/key, read screenshot receipts before an identical retry, and block edits, new batches, mode changes or changed research intent until settled.45 targeted tests and an independent overlapping72-test review passed with no skips. Cross-refresh import intent persistence remains outside this implementation.
- [ ] Run the final complete `npm run test:client` after all combined edits. Earlier full run:607/607,0 skips; final result remains pending.

## 4. Repair team and research continuity

**Files:** `client/src/features/teams/GuidedTeamCreate.tsx`, `guided-team-create.ts`, `guided-team-storage.ts`, `TeamRunPanel.tsx`, team canvas/outline, `client/src/pages/Analysis/ResearchWorkspacePage.tsx` and archived conversation empty state, corresponding client tests.

- [x] Test draft persistence through refresh and visiting friends, unknown-result continuation with the same key, and known changed-state recovery without duplicate resources. Definite member/source denials allow a safe end; unknown requests remain fixed. Guided permission repair:40/40,0 skips.
- [x] Save editable pre-start fields in owner-scoped tab storage; revalidate selected IDs/versions rather than treating a cached profile as authority. Storage and legacy-owner validation reviewed; interaction regressions are tracked separately.
- [x] Provide an explicit safe exit for resolved obsolete creation progress, retaining existing team/account resources and unknown receipts. Source guard rejects exit while a pending operation remains.
- [x] Use frozen animal identities in team and research selectors; render actual selected agents in empty states. Collapse the new-chat member picker so the composer remains accessible on mobile.
- [x] Fix commission-history links to `/teams/:id?panel=history&commissionId=...`; use user-facing Chinese/English team descriptions and clearly labelled budget caps. Exact links passed regression tests and an interactive selected-commission browser check.
- [x] Run guided creation, research member and team runtime client suites, including rendered interactions:128/128 with no skips in the adjacent suite. A full fictional HTTP browser startup retained selected members and budget across refresh and reached the running team.

## 5. Visual acceptance and integration review

- [x] Inspect the main pages and relevant dialogs at1440×1000 and390×844 using fictional fixtures. Final daily mobile pages and desktop main pages had no horizontal overflow or page errors; the inspected animal dialog fits and scrolls.
- [x] Exercise animal selection/save/reload, CSV save→friends, team startup through refresh, selected research participants and investment/holdings switching without a real model call. The validation record lists the exact exercised scenarios.
- [x] Exercise the commission-history link interactively, render the selected fictional commission and switch the interface to English. No page errors or horizontal overflow; both screenshots were visually inspected.
- [x] Check visible names, active navigation, accessible labels, wrapping, overflow, primary actions and collapsed controls through the recorded browser inspections and focused interaction tests. The mobile research composer is visible in the first viewport.
- [x] Repair browser-discovered duplicate holdings links, portal palette inheritance, hidden mobile holdings navigation and the tall research-member list. Visual-polish tests:30/30; mobile tests:29/29; no skips. Final light/dark/arcade portal and mobile visual rechecks passed. Remove the misplaced watchlist-only notice from holdings/ledger context and pass its3/3 rendered regressions.
- [x] Review `docs/architecture.md` five diagrams and contributor references semantically. Update the affected identity/route descriptions and verification evidence. Identity and client recovery are documented beside the unchanged authority edges.
- [ ] Run lint, `npm run build:web`, client/server/native suites with required disposable prerequisites, architecture/context checks and dev tests.
  Final lint and Web build passed before the final copy-only removal; its3/3 render tests and follow-up client rebuild passed. The final complete client suite remains pending, and complete server/native verification is required in Linux CI. The Windows POSIX-only dev skip remains explicitly recorded.
- [x] Request independent specification and code-quality reviews and resolve reported issues. Final independent review found no actionable P1/P2 findings; its72-test overlapping rerun passed with no skips.

## 6. Deliver the verified release

- [ ] Create a PR against current main and satisfy all protected checks: Lint & typecheck, Agent tests, Docker image build.
- [ ] Merge within the existing session authorization; sync the managed contributor skill.
- [ ] Build a separate source release, back up and verify current data plus matching keys/native/artifacts, validate migration66 on isolated restore, then perform a controlled app switch.
- [ ] Verify live read-only page/API reachability and deployed bundle/revision. Do not use personal state for write acceptance or restart Docker for an application-only release.
