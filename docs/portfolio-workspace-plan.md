# Portfolio Workspace Implementation Plan

> **For agentic workers:** Use the repository contributor workflow and subagent-driven development. Execute the independent work packages below with explicit file ownership, then review specification compliance and implementation quality before integration.

**Goal:** Implement the reviewed Figma workspace with a large truthful comparison chart and independently managed simulation strategy combinations.

**Architecture:** Retain real and simulation ledgers and the strategy source/confirmation library. Scope runtime selection, policy revisions and combination authorization to accounts. Add pure saved-observation comparison reads and a new current-experience shell without removing legacy routes.

**Tech Stack:** React 19, TypeScript, TanStack Query, ECharts, NestJS, Drizzle, PostgreSQL 16, Node test runner.

Baseline: `9e2d83a`; isolated branch `codex/portfolio-redesign`. Design contract: `docs/portfolio-workspace-design.md`.

## Package 1 — Account and combination persistence

Files: `shared/portfolio-workspace.interface.ts`; `server/database/portfolio-workspace.schema.ts`; `scripts/db/45_portfolio_workspace.sql`; `server/common/platform/database.provider.ts`; `server/database/schema.ts`; `server/modules/paper-trading/portfolio-workspace.service.ts`; `portfolio-workspace.controller.ts`; `investment-policy.service.ts`; `investment-policy.controller.ts`; `user-investment-strategy.service.ts`; `paper-trading.module.ts`; focused integration tests.

- [x] Define account summary, account combination, preview and apply DTOs, with explicit account ID and expected policy revision. GET list/detail must be owner filtered; mutation receipts include the account in identity.
- [x] Migrate active-account and runtime-profile uniqueness to account scope. Preserve old index names with compatible new definitions because startup reruns historical migrations. Backfill only existing active policy strategy snapshots; do not revive archived accounts.
- [x] Expose `GET/POST /api/ai-investment/accounts`, `GET /accounts/:accountId`, scoped pause/resume, and `GET /accounts/:accountId/strategies`, `POST .../preview`, `POST .../apply`. New creation reuses reviewed seed/cash validation and retains other accounts.
- [x] Combination inputs use `strategyId`, `strategyRevision`, `allocationPct`, `enabled`; total allocated budget cannot exceed 100. Preserve the account cash floor separately. Preview validates overlap conflicts, snapshots and sources. Apply repeats validation under owner/account/policy locks and checks the preview hash and expected revision.
- [x] Prevent deletion of any strategy referenced by an account or execution history. Preserve immutable report/strategy history and existing source import behavior.
- [x] Test two-account creation, owner isolation, account-specific idempotency, preview expiry after revision/source change, combination conflicts, migration upgrade and a second complete startup with two running accounts.

Representative request contract:

```ts
type AllocationInput = {
  strategyId: string;
  strategyRevision: number;
  allocationPct: number;
  enabled: boolean;
};
type ApplyCombination = {
  expectedPolicyRevision: number;
  requestKey: string;
  previewHash: string;
  allocations: AllocationInput[];
};
```

## Package 2 — Account-scoped runtime

Files: `user-strategy-runtime.ts`; `strategy.scheduler.ts`; `strategy.service.ts`; `strategy-store.service.ts`; `strategy-mandate.service.ts`; `paper-trading.service.ts`; `investment-policy.fence.ts`; relevant shared mandate/candidate interfaces; runtime integration tests. Coordinate shared schema/contract changes with package 1.

- [x] Compile enabled immutable assignments into one mandate per account, preserving original strategy and entry identities and a namespaced rule ID. Runtime profile selection comes from the account mandate.
- [x] Scope scheduling, process guards, active checks, sellable shares, sizing, protections and order paths to `owner + accountId`. Existing single-account paths remain compatible; ambiguous old writes fail.
- [x] Enforce shared account cash and risk plus allocation budget caps inside the same account transaction. Keep reservation and filled-entry identity stable across combination edits and pause/resume.
- [x] Final execution fence checks account state, current policy revision, enabled assignment, immutable strategy revision and rule identity. Changing or pausing A invalidates A candidates only.
- [x] Verify A/B simultaneous scheduling, pause isolation, stale candidates, repeated-entry prevention, contradictory strategies and competing cash reservations with fictional fixtures.

## Package 3 — Saved-observation comparison

Files: `shared/portfolio-comparison.interface.ts`; `server/modules/paper-trading/portfolio-comparison.service.ts`; comparison controller; registration in `paper-trading.module.ts`; `portfolio-comparison.rules.ts`; tests.

- [x] Read owned `portfolio_value_points`, `paper_snapshots`, account seed and creation metadata without quote fetches or research. Return per-series actual timestamps, completeness, gaps, equity, valid return values and methodology.
- [x] Bound requested period, sort/deduplicate observations, preserve missing values and account inception. Daily simulation observations must not become invented intraday precision.
- [x] Keep returns unavailable when external cash flows or baseline changes cannot be valued reliably. Provide an explicitly labelled equity-change mode only when it is mathematically valid; never label NAV change as cash-flow-adjusted return.
- [x] Test initial-only, late inception, missing day, incomplete holdings/FX, duplicate dates, cross-owner IDs and cash-flow gaps.

Pure chart datum contract:

```ts
type ComparisonPoint = {
  timestamp: string;
  equityUsd: number | null;
  returnPct: number | null;
  gaps: string[];
};
```

## Package 4 — Frontend workspace and journeys

Files: `client/src/app.tsx`; `components/Layout.tsx`; `themes.css`; `hooks/use-theme.ts`; `utils/simple-experience.ts`; new `pages/Overview/`; `features/portfolio-comparison/`; `pages/Paper/SimulationAccountsPage.tsx`; account detail/editor; `api/portfolio-workspace.ts`; `api/portfolio-comparison.ts`; existing strategy feature/editor/source components; `components/ReportExecutionPlan.tsx`; analysis/report/channel/asset/settings styles.

- [x] Replace the current home with a pure-read portfolio overview. Preserve existing legacy experience. Add `/paper/:accountId` and combination editing routes; keep `/paper` as the account list.
- [x] Implement the Figma white/sage shell, six stable navigation destinations and mobile navigation. Preserve language, logout, appearance and account-mode guards.
- [x] Render large ECharts time-series with stable account colors, line patterns, period/metric/account controls and a shared tooltip. Default to equity. Display missing-data reasons and avoid fabricated demo values.
- [x] Add independent account creation, selection, compact-detail chart, holdings/trades/risk tabs and scoped pause/resume. Reuse seed preview/cash controls and strategy source/confirmation components.
- [x] Build combination draft/preview/apply with grouped actions and clear target account. Editing invalidates preview. Disable applying incomplete/conflicting combinations and show server validation.
- [x] Change report action to choose an account and save a draft before application. Preserve immutable report content and citations. Improve supporting-page spacing and hierarchy through shared tokens and focused wrappers.
- [x] Add Chinese/English strings. Cover keyboard access, empty/loading/error views, all mobile account entries and narrow widths.
- [x] Test cache isolation, explicit account IDs, saving without applying, invalidated previews and report-to-draft path. Render fixture screens at 1440px and 390px; inspect screenshots.

## Package 5 — Review, checks, documentation and preview

- [x] Independent specification review checks every journey and the eight accepted designer findings. Fix findings before code-quality review.
- [x] Review all five diagrams in `docs/architecture.md`; update account/combination execution and overview-read flows. Update contributor map, execution contracts, migration/test guidance and per-area metadata. Unchanged research publication and real-ledger write boundaries receive explicit no-impact notes.
- [x] Run targeted tests during implementation, then `npm run lint`, `npm run test:server`, `npm run test:client`, `npm run test:local-agents`, `npm run test:architecture`, `npm run test:wiring`, `npm run build:web`, `npm run test:context`, `npm run check:context`, and `git diff --check`. Database tests use only a verified disposable cluster; report prerequisites/skips accurately.
- [x] Build a separate private preview instance with fictional data, independent ports and no personal agent connections. Verify account selection, charts, draft/preview/apply and pause isolation. Do not migrate the personal instance as a smoke test.
- [x] Commit focused changes and open a PR. Required CI remains Lint & typecheck, Agent tests, Docker image build. Report the actual deployed preview URL, Figma URL and verification evidence. Delivery: [PR #88](https://github.com/Lueyu/squabble/pull/88); detailed [verification record](portfolio-workspace-validation.md). Required CI status is recorded on the PR, independently of local acceptance.

## Execution notes

The user explicitly requested design refinement, independent designer review, a development plan, implementation and a preview. Execute without a new confirmation gate. Prefer safe reversible implementation and isolated preview over changing the personal running release. The unfinished static design preview is not evidence of an implemented or deployed application.
