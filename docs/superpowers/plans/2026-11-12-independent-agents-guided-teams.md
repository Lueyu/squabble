# Independent Agents and Guided Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Track steps with checkbox syntax. The user has authorized implementation, tests, PR merge after required checks, and local deployment.

**Goal:** Deliver the approved holdings-first, persistent-agent, autonomous paper-team experience with understandable defaults, real A2A integration and versioned operational evidence.

**Architecture:** Add a roster and immutable agent versions above existing connections and Council execution. Teams reference roster versions and use persisted standing agreements to produce bounded commissions and explicitly attributed paper-strategy decisions. Reuse existing account, source, budget, recovery and ledger authorities.

**Tech Stack:** React/TypeScript, NestJS, Drizzle/PostgreSQL, Node test runner/tsx, Playwright, existing GitHub CI and local source-release launcher.

**Specification:** `docs/superpowers/specs/2026-11-12-independent-agents-guided-teams-design.zh-CN.md` (written specification approved by the user's instruction to implement).

## Ownership and execution order

The root owns aggregation/wiring (`server/app.module.ts`, schema exports and migration registration, package scripts), client integration, docs, final validation, PR and deployment. One implementation subagent owns the isolated roster module first; subsequent implementers receive explicit non-overlapping file ownership. Read-only preparation can proceed concurrently. No tests use personal data or paid models.

### Task 1: Persistent roster and version authority (P0)

Files: create `shared/agent-roster.interface.ts`, `server/database/agent-roster.schema.ts`, `scripts/db/62_agent_roster.sql`, `server/modules/agent-roster/`; modify schema exports, migration registry/fresh schema, Council member identity and selected-participant path.

- [x] Define profile/version/executor/permissions wire types; expose `/api/agent-roster` list, templates, detail, create, update and archive.
- [x] Write owner/idempotency/revision/archive/version tests before implementation. A replayed request returns the original identity; a foreign owner's ID never resolves; updating creates an immutable version.
- [x] Implement owner-fenced transactions and receipts. Separate credential references from immutable capability versions.
- [x] Implement private memory spaces and explicit share provenance without cross-team implicit recall.
- [x] Add optional `rosterAgentId`/`rosterAgentVersionId` to member snapshots; preserve local connector ID and role/seat IDs.
- [x] Run focused suite with a disposable `RESEARCH_TEST_DATABASE_URL`; verify 62 fresh/upgrade/replay parity.

Example invariant:

```ts
assert.equal(replayed.id, original.id);
assert.notEqual(updated.currentVersion.id, original.currentVersion.id);
await assert.rejects(() => roster.detail(otherOwner, original.id));
```

### Task 2: Guided client and reusable agents (P1)

Files: create `client/src/api/agent-roster.ts`, `client/src/features/agent-roster/`, `client/src/features/onboarding/`; modify `client/src/app.tsx`, navigation, overview, existing model setup and team creation components.

- [x] Test the three-step state derivation from saved holdings/roster/team facts, stale/unknown submit handling and default connection reuse.
- [x] Implement `/friends` with readable capability cards, recommended templates, short-description creation, version editing, archive and optional trial chat.
- [x] Implement resumable holdings → roster → team checklist with conditional AI setup. Every ordinary screen has one main action and at most three required choices; advanced fields are collapsed.
- [x] Keep `/paper` as simulation accounts and old links reachable. Keep account identities distinct from roster people.
- [x] Provide Chinese/English labels and reason-plus-next-step failures; use existing connection APIs/credential storage.
- [x] Run client tests and verify 1440px/390px intercepted fictional browser journeys.

```js
assert.deepEqual(onboardingSteps(facts).map(step => step.id), ['holdings', 'friends', 'team']);
assert.equal(onboardingSteps({ ...facts, hasHoldings: true })[0].complete, true);
```

### Task 3: Team membership and autonomous paper execution (P2)

Files: extend team shared contract and graph validation; create standing-agreement schema/migration/service/controller/scheduler; modify team runtime/version/decision and paper strategy adapters plus team client workflow.

- [x] Test roster owner/version references, same-person self-review rejection and revoked capability fences.
- [x] Select existing agents, freeze versions and retain role-specific permission intersection. Existing legacy teams remain readable and explicitly upgradeable.
- [x] Test standing agreement request replay, one active cycle, lease/restart behavior, cross-period budget reservations, expiry and authority revision changes.
- [x] Persist finite cadence/limits/account/permissions agreement. Produce bounded commissions using existing preview/create/worker ports; never globally resolve unrelated participants.
- [x] Attribute automatic acceptance/application to the system and agreement revision, preserving exact accepted attempt/source/preview/account checks.
- [x] Reuse actual paper execution; no-action remains valid. Start from confirmed holdings/cash snapshot, then read simulation state only.
- [x] Implement pause across new commissions, in-flight final publication/application and all account automation. Unknown remote work remains accounted for; resume does not duplicate old cycles.
- [x] Validate disposable integration cycle, denied/uncertain outcomes, repeated ticks, pause/resume, cost/call ceilings and retained ledger.

```ts
await Promise.all([scheduler.tick(now), scheduler.tick(now)]);
assert.equal(await cycleCount(agreement.id, period), 1);
await agreementService.pause(owner, agreement.id, revision);
assert.equal(await canApplyLateResult(agreement.id), false);
```

### Task 4: Explicit research and meaningful analysis (P3)

Files: `shared/simple-conversation.interface.ts`, Council selection/context/dispatch, research workspace controls, telemetry shared/schema/query/projection and affected tests.

- [x] Test same-model distinct roster participants and single-agent direct response versus bounded moderated multi-agent flow.
- [x] Pass participant/version selection through durable request identity and saved snapshots; use private/team context fences.
- [x] Preserve budget/time/call bounds, partial outcomes and explicit cancellation; do not infer correctness from consensus.
- [x] Carry agent/version/team/commission/work/attempt references into operational metadata and filters; do not duplicate cost or invent model/usage values.
- [x] Add readable quality/feedback and detail links; preserve metadata-only external exports and deferred RL episode references.
- [x] Run affected council, memory, telemetry and client regression suites.

### Task 5: Real A2A adapter (P4)

Files: roster external connection contracts, dedicated transport/runtime adapter and persistence, Council dispatch bridge, client external-agent wizard, integration server tests.

- [x] Fix supported protocol/transport using current official specification and target-server capability discovery.
- [x] Test real HTTP protocol exchange with a local standards-conforming fixture server: card, authenticated send, task get, artifact, cancel and unknown state. This is protocol integration, not a fake adapter return value.
- [x] Implement URL/egress/credential protections, bounded polling, durable correlation and cancellation; never resend uncertain remote calls automatically.
- [x] Register remote identity as a roster agent and support permitted research/team work; reject unsupported lead/structured-output capabilities.
- [x] Show observed versus unknown fields, and explicit remote data payload grants. Test owner isolation, timeout, cancellation and source/authority revocation.

### Task 6: Integration, review and merge

- [ ] Run `npm run lint`, `npm run test:server`, `npm run test:client`, `npm run test:local-agents`, `npm run test:memory-eval`, `npm run test:architecture`, `npm run test:wiring`, `npm run build:web`, context tests/checks and focused real-browser/real-A2A cases. Use dedicated disposable DB variables and report skips.
- [x] Update the five affected architecture flows, usage docs, contributor skill and current verification notes without claiming unperformed novice acceptance.
- [x] Perform spec compliance review followed by code-quality review; fix findings and rerun affected checks.
- [ ] Commit, push and open PR. Wait for Lint & typecheck, Agent tests and Docker image build; address all review threads and merge through the PR without bypassing checks.

### Task 7: Local deployment and final verification

- [ ] Verify current local launcher/process/port/database/state paths from private locator and live read-only evidence.
- [ ] Back up database plus environment/credentials/native state/artifacts/imports; restore into a new isolated DB and verify recoverability.
- [ ] Build/install the merged source release with the same durable paths and keys; apply additive migrations and switch the hidden local launcher.
- [ ] Verify running merged revision, health/auth, existing asset/report/team readability, new roster/onboarding pages and migration logs without initiating paid research.
- [ ] Update private locator and synchronize managed global project skill after merge. Retain one current application release per existing preference while preserving data and recoverable backups.
- [ ] Record actual checks, PR/merge/deployed SHA, URL and remaining real-user usability validation. Five-person novice testing is a release acceptance target, not evidence that can be fabricated by automation.
