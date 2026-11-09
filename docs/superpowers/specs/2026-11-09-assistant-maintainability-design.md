# Maintainable intelligent investing assistant

## Decision and scope

The maintainer selected gradual convergence on 2026-11-09 and delegated execution.
The product direction is an intelligent investing assistant: portfolio-aware
research, coordinated agents, readable reports, a stock-friend channel and
explicitly applied simulated strategies. This change improves the structure of
those existing capabilities. It does not add brokerage execution or claim a new
autonomous trading feature.

Current Web behavior and historical reports, strategies and receipts remain
supported. Desktop packaging stays paused. Source traceability is a supporting
capability rather than the product's headline; existing source validation,
owner isolation and execution checks remain intact during this refactor.

The inspected baseline is `46cb370`. Implementation uses a separate branch and
reviewable commits; no running personal instance or database is used for tests.

## Architecture

Keep the React/Nest/PostgreSQL application as one deployable application. Make
the following dependency boundaries explicit without adding a framework:

- `server/modules/research-core/` owns shared model calls, evidence collection,
  financial-source adapters and portfolio context. Current Council research and
  retained analysis consume the same providers. This module does not depend on
  the retained pipeline or on the current experience facade.
- `server/modules/research-routing/` owns selection of a usable configured
  research executor. Experience and simulated investing import one exported
  provider rather than registering a service from another feature's directory.
- `client/src/features/investment-strategies/` owns strategy import, editing,
  review and management. Pages compose this feature; the feature never imports
  page implementations. The editor separates asynchronous operations from form
  sections and saved execution-detail presentation.
- `multi-agent/` retains legacy run/pipeline APIs and historical readers. This
  change removes shared infrastructure from that directory, not live APIs or
  migration files. Legacy-only portfolio mutation remains with its existing
  command owner rather than becoming a new research-core responsibility.

Use direct, named file imports and Nest exports. Do not add duplicate provider
registrations or compatibility re-export files solely to avoid updating internal
callers. The existing Settings-local LLM provider may remain if removing it would
require a separate global-settings dependency redesign; document that exception.
Move associated tests and update their imports and test discovery.

## Contracts that must remain stable

1. Routes, API payloads, bilingual visible text and persisted schemas retain
   their behavior. Existing report IDs and strategy deep links still work.
2. Agent completion, local acceptance and report publication remain distinct.
   Refactoring never redispatches a saved task or invokes a real model in tests.
3. Strategy drafts and confirmed execution authority remain distinct. Application
   uses the saved revision, preview hash, expected current strategy and request
   key. Unknown preparation outcomes are reconciled from receipts before retry.
4. A fresh strategy edit cannot be overwritten by an unrelated late status read.
   Existing cancellation, locking, idempotency and preview behavior is preserved.
5. Recorded real assets and the simulated ledger remain separate. Final order
   validation and source revocation checks are not weakened.

## Readability and comments

Use normal multiline TypeScript/TSX formatting in changed production files.
Extract by responsibility, not a target line count. Public hooks and services
state their inputs, outputs and side effects. Comments explain intent, lifecycle
decisions and invariants, especially receipt recovery, preview/application and
provider wiring; they do not narrate obvious assignments. Keep code comments in
English to match contribution rules and provide a concise Chinese reading tour.

## Durable maintenance

Add automated import boundaries for the extracted modules and shared contracts.
Run them through the existing lint/CI entrypoints, with negative fixture checks
showing that forbidden imports are rejected. Do not impose a blanket rewrite of
unrelated historical code.

Keep one short `AGENTS.md` router to the repository-owned contributor skill.
The documentation index leads to current Web workflows, architecture, development
and recovery. Mark historical product proposals as superseded and keep them out
of the default development path. Remove duplicated moving facts (such as the
latest migration number) where code already owns the authoritative list.

A Chinese code-reading guide follows one report-to-strategy-to-channel journey,
names exact entrypoints and explains the technical tradeoffs that a contributor
can verify. A product direction section distinguishes implemented capabilities
from future work; it promises neither investment returns nor GitHub stars.

## Validation and delivery

First run the existing focused frontend and research tests as a baseline. After
refactoring run focused tests, typechecking, all required application suites,
context checks and `build:web`. Database tests use a new disposable PostgreSQL
cluster with fictional data and all required test variables. Do not describe
skipped database cases as passing integration coverage.

Review the diff for behavior changes, module initialization cycles, duplicate
providers, test discovery regressions, broken links and accidental private data.
Use independent code review, address actionable findings and open a pull request
with exact validation results. Merge and deployment are separate from this
delivery. Record the remaining legacy boundaries honestly.

## Acceptance

- Strategy functionality no longer lives in the Today page directory, and its
  asynchronous operations can be read separately from its form and review UI.
- Shared research services have one clear module owner, with no dependency on
  the legacy pipeline; routing no longer makes paper trading depend on experience.
- Existing behavioral and integration checks still pass after import migration.
- The automated checks reject newly forbidden dependencies.
- A new contributor can locate the current user journey, its checks and its
  retained compatibility boundaries from one short entrypoint.

## Product references

These are design influences, not claimed integrations:

- [Robinhood Cortex engineering](https://robinhood.com/us/en/careers/blog/loop-stays-dumb-so-the-model-can-be-smart/): keep the orchestration mechanism understandable and tools explicit.
- [Clowder AI](https://github.com/zts212653/clowder-ai): coordinated agent roles and shared conversation are relevant product ideas.

The future product can emphasize useful investment opinions and engaging agent
conversation while keeping execution permissions and observable task outcomes
clear. New orchestration features and a browser-to-backend showcase scenario are
separate follow-up work, rather than unverified claims in this structural change.
