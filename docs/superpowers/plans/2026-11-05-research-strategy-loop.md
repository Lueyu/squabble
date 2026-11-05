# Research to Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development. Execute all checked-in tasks without another user approval gate; the user approved the linked design on 2026-11-05.

**Goal:** Connect immutable daily and stock reports to topic discussions, versioned strategy mandates, risk-routed paper execution and independent real-portfolio seeded experiments.

**Architecture:** Extend current main (81bfbfb), keeping Council, research memory, strategy signals and the paper ledger. Add a neutral ResearchDocumentsModule for immutable artifacts; enrich Council sessions with scene/references/forks; introduce period mandates around daily plans and independent experiment seed/cash state. All automated routes finish in deterministic paper validation. SQL migrations are additive and must run both on fresh schemas and upgrades.

**Tech Stack:** React 19, NestJS, Drizzle/PostgreSQL, node:test via tsx, React Query. Current project phase is web-only; desktop changes/packaging are paused.

## Coordination and existing work

- Worktree: C:/Users/97956/.codex/worktrees/research-strategy-loop/daily-portfolio-analysis; branch codex/research-strategy-loop. Original dirty checkout stays untouched.
- Spec: docs/superpowers/specs/2026-11-05-research-strategy-loop.md.
- Root owns server/app.module.ts, client/src/app.tsx, client/src/api/index.ts, database.provider.ts, Dockerfile, package.json, scripts/db/01_schema.sql and CI migration list. Workers must not modify these.
- Reports worker owns new research-documents module/schema/shared contract and Analysis page integrations; migration 26_research_documents.sql.
- Council worker owns Council backend/frontend/shared contract/schema and reference/context integration; migration 27_research_threads.sql.
- Experiments worker owns experiment service/schema/contracts and paper-trading.service/controller, PaperPage and Holdings entry. Migration 28_simulation_experiments.sql. Root owns strategy* and mandate* files and Paper/StrategyWorkbench.tsx. PaperTradingModule wiring is root-only.
- Root owns migration 29_strategy_mandates.sql, strategies/mandates/routing/shared strategy contracts and end-to-end integration.
- Workers use fresh spec-aware review after their implementation, and root performs spec review before quality review. Mutations stay in exclusive files; shared boundary changes are reported before editing.

## Boundary contracts

Reports expose these identities and methods (worker finalizes types before consumers compile):
```ts
type ReportReference = { versionId: string; sectionId?: string; excerpt?: string };
type ReportSource = { type: 'daily' | 'deep' | 'portfolio' | 'council'; id: string };
resolveReferences(owner: string, references: ReportReference[]): Promise<ResolvedReportReference[]>;
importSource(owner: string, source: ReportSource): Promise<ResearchDocumentVersion>;
```
Versions expose id, reportId, version, title, kind, ticker, content, sections, dataAsOf, availableAt, createdAt, snapshot, source and parentVersionId. Ownership is checked before resolution. Public revision/approval metadata never changes version content.

Navigation uses /analysis/reports/:versionId. From a source report create/import an immutable version then link /council?referenceVersionId=...&scene=portfolio_daily or stock. Strategy drafts link /paper?sourceReportVersionId=...&draft=1, optionally sourceSessionId. Strategies reference exact report versions, never a latest pointer.

## Task 1 Immutable documents and report reading

Files: shared/research-document.interface.ts; server/database/research-documents.schema.ts; server/modules/research-documents/{research-documents.module,controller,service,rules}.ts; migration 26; client/src/api/research-documents.ts; client/src/pages/Analysis/ResearchDocumentPage.tsx; existing Analysis/DeepReport/PortfolioReport reading entry points; agent report writes and portfolio analysis completion hooks.

- [x] Write and run failing tests for same-task idempotency, changed-content conflict, immutable source references, cross-owner denial, stale adoption and branch isolation.
- [x] Implement document + version + adoption identities; content hashes; bounded request validation; draft parent/version checks; input snapshots and missing-time flags.
- [x] Register current source reports (daily, deep, portfolio, Council) and persist full identity at creation; legacy import retains missing metadata as unknown.
- [x] Add editable revision draft, section diff, adoption action, historical version selection, report-to-Council handoff and source provenance.
- [x] Verify exact historical source resolution and back-links. Sources unavailable or revoked must remain visibly invalid, never resolve to another report.
- [x] Run tsx --tsconfig tsconfig.node.json --test server/modules/research-documents/*.spec.ts and targeted client tests.

## Task 2 Scene discussions and version-pinned context

Files: shared/council.interface.ts; server/database/council.schema.ts; server/modules/council/*; migration 27; client/src/pages/Council/*; client/src/api/council.ts; client/src/hooks/use-council.ts.

- [x] Write failing tests for scene validation, exact references, user reply IDs, fork ownership and immutable fork context.
- [x] Add title/scene/subject/period/parent message or report and pinned references to session; stock remains backwards-compatible.
- [x] Resolve reference content on server and inject into actual model/native/workflow context, not only UI. Portfolio sessions skip invalid ticker-only research and use selected portfolio snapshot/constituents.
- [x] Expose creation presets, pinned cards, selected-section reply, fork action and stage summaries; avoid silent loss at the 30-message limit.
- [x] Persist Council outputs as document versions; add repair/report revision and strategy-draft entry without granting orders from research chat.
- [x] Add revision invalidation, input-changed feedback and deep links distinguishing trade pre-review from post-trade review.
- [x] Run existing council/context/workflow suites plus new behavior tests.

## Task 3 Real-account seed and independent paper experiments

Files: shared/simulation-experiment.interface.ts; server/database/simulation-experiments.schema.ts; server/modules/paper-trading/simulation-*; paper-trading.service/controller.ts; client/src/pages/Paper/PaperPage.tsx and experiment components; HoldingsPage.tsx; migration 28.

- [x] Write failing tests for opening entries/no fake buys, cash and share conservation, unknown cash/FX, source revision conflicts, idempotency, current-account isolation, and initial-value performance.
- [x] Capture owned holdings, per-currency cash and current valuation/FX with timestamps and gaps, plus sellability/restriction data; preview before atomic create.
- [x] Preserve original-cost metadata, use initial marked value for experiment returns, keep per-currency balances and explicit FX cash transfers; never spend USD against foreign cash implicitly.
- [x] Support creating/listing/selecting experiments without reset or deletion; selection stops old automation and invalidates in-flight work. All ledger queries scope account.
- [x] Integrate currency solvency/settlement and fresh quote checks into all order paths; no AI approval may use the manual guardrail bypass.
- [x] Add preview/validation UI, one-click Holdings entry, experiment selector, independent initial-buy-and-hold comparison and date-range review.
- [x] Enforce fees/slippage settings and unsupported corporate-action/data states explicitly; don't backfill orders after offline gaps.
- [x] Run paper safety/race and new DB tests against disposable data.

## Task 4 Period strategy mandates and three-route execution

Files: shared/strategy.interface.ts; shared/strategy-mandate.interface.ts; server/database/strategy-mandates.schema.ts; server/modules/paper-trading/{strategy-route.rules,strategy-mandate.rules,strategy-mandate.service,strategy-mandate.controller}.ts; strategy.service/store.ts; client/src/pages/Paper/StrategyWorkbench.tsx; client/src/api/strategy-mandates.ts; migration 29.

- [x] Write failing route tests: hard block wins; protection bypasses deliberation; low-risk deterministic direct; semantic ambiguity AI; large post-trade exposure Council; rolling accumulation prevents split-order evasion; no confidence-only bypass.
- [x] Write failing mandate tests: date/market boundaries, source version ownership, no unmeasurable published rule, account-scoped authorization, stale publish conflicts, version expiry and protection preservation.
- [x] Implement draft extraction from selected report/session, editable rule cards, publication diff, daily/month/custom period and explicit delegated daily-plan limits.
- [x] Bind published mandate to exact source versions/account/profile/expiry; freeze prior candidate/approval/preallocation at replacement; retain protective stop ownership.
- [x] Route fixed candidates with recorded reason. Reuse model review and Council exact-candidate review. Revalidate latest quote, account, mandate and report dependencies before placeOrder.
- [x] Propagate fact revocation to affected increased-risk rules, retain protectives, and show pending re-research. Handle budget/offline/uncertain paid work without direct-route fallback.
- [x] Add deterministic observable route records and report/session/order backlinks. Compile daily execution from rules only inside mandate constraints.
- [x] Run route/mandate tests, strategy integration/research fences and quote/risk regressions.

## Task 5 Integration, migration and UI verification

Files: root-owned registry files, docs/research-strategy-loop.md and Chinese counterpart, tests and migration fixtures.

- [x] Register module/routes/exports/migrations. Keep base SQL and migrations consistent; keep Docker/CI migration packaging current.
- [x] Initialize a fresh disposable PostgreSQL and verify tables/indexes, then apply additive migrations twice and verify preserved fictional legacy data.
- [x] Execute a fictional report v1 -> thread -> report v2 -> strategy draft -> published mandate -> seeded experiment -> routed decision -> review loop. Include a concurrent stale-version and duplicate-request case.
- [x] Run npm run lint; npm run test:server; npm run test:client; npm run test:local-agents; npm run test:dev; database-backed memory evaluation; npm run build:web. Record baseline failures separately and fix regressions.
- [x] Inspect desktop-width and narrow browser UI using a disposable app instance with fixture model calls. No personal provider sessions or paid research.
- [x] Independent spec review covers all 15 design sections; independent quality review covers ownership, races, date/valuation correctness and accessible UI. Resolve findings before final completion.
- [x] Commit only task changes; deliver branch and validation evidence. Do not publish or merge without the user-required concrete review.

Final verification: server 641/641, client 201/201, local agents 167 passed with one Windows platform skip, dev 8 passed with one POSIX skip, memory evaluation 99/99, lint and Web build passed. Fresh/upgrade migrations preserve the fictional legacy ledger and match 956 column definitions. Detailed browser and integration evidence: [validation record](../../research-strategy-loop-validation.md).
