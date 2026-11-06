# Research, execution and provenance contracts

Use this reference for current research, report import, strategy state, channel publication and ledger changes. Paths are relative to the selected repository checkout. See [repository-map.md](repository-map.md) for routing and `docs/architecture.md` for the five diagrams. Checked at `7de30fb` on 2026-11-07, with saved-report recovery and simulation-review reading additionally checked at `f0fb2a0` (PR #80) on the same date; inspect affected source after subsequent changes.

## Today → sealed research → immutable report

1. `client/src/pages/Today/TodayPage.tsx` reads `/api/today`. `CurrentAnalysisPanel.tsx` and `client/src/api/simple-experience.ts` use `/api/research/current` and the explicit refresh/cancel/reformat endpoints in `server/modules/experience/experience.controller.ts`.
2. `CurrentResearchService` uses owner/topic/business-date projections, generation sequence/identity and durable submission receipts. Current portfolio refresh dispatches through `DailyChannelResearchService`, which calls `SimpleCouncilService.create` with `researchOnly: true`. `ExperienceModule` wires this route. The older `PortfolioAnalysisService` fallback still exists; do not document it as the default Today pipeline.
3. `SimpleCouncilService` freezes context and executor choices. `CouncilService` persists each independent submission in `council_independent_submissions` before it can influence the later shared stages. Inspect `server/modules/council/council.service.ts` around independent submission/release, `council.dialogue.ts` for stage planning/parsing, and `council.daily.ts` for daily-specific prompts. This is independent research followed by inspection; the current daily job is not a staged public bull/bear debate.
4. The daily challenge must return `reverseCheck`. Outcomes are `critical_counterevidence`, `partially_weakened`, `no_counterevidence_found`, or `unable_to_verify`. Preserve checked premises, findings, evidence IDs and gaps. No counterevidence is not proof; inability to verify remains explicit. Summary preserves coverage and disagreement and separately proposes `executionPlan`.
5. `server/modules/paper-trading/report-execution-plan.ts` validates `schemaVersion: 1`, `parameterOrigin: 'ai_proposed'`, exact evidence IDs, draft entries, validity windows and limits. It derives `readiness` (`ready`, `needs_info`, `no_trade`) and preview; archived derived fields are recalculated, not trusted. Numeric evidence binds a suggested parameter to proposal text, not to an independently proven market fact. Missing/invalid plans never become invented orders.
6. `ResearchDocumentsService` publishes immutable content/sections/snapshots as `research_document_versions`; mutable current pointers and later revocation metadata are separate. The execution section ID is exactly `execution-strategy`. `DailyChannelResearchService.syncPublished` ingests published reports into the channel and may idempotently import a still-valid typed plan as a **draft**. Historical, revoked, expired and prose-only reports must not awaken as fresh automatic strategy proposals.

The first completed daily report and latest discussion-derived report are separate projections (`CurrentResearchService.getDailyReports`). A newer discussion must not silently rewrite the initial report. Past dates are read-only for refresh. Automatic research is also gated by preferences, route readiness and `AutomaticResearchBudgetService`; discovering these methods does not authorize running them.

Execution recovery is persistent: current projections reconcile retained results, native journals retain submission identity, and interrupted native tasks are not replayed automatically. Do not turn read/recovery operations into implicit paid retries.

Saved-report reading and recovery have separate boundaries:

- `CurrentResearchView.returnedDocumentId` identifies the available, non-revoked archive for a result whose formatting is pending. `CurrentAnalysisPanel` links to that exact version while keeping any earlier complete report visible; it must not describe returned research as research that has not run. A formatting retry error leaves the saved-report link available.
- `POST /api/research/current/reformat` uses `CurrentResearchService.completedSource` to resolve a retained completed portfolio run or a published daily-team report. It also recognizes old `formatting_portfolio` receipts that actually contain a daily session ID. It imports/reads the saved source under the submission receipt, rejects revoked material and updates the current projection; it does not rerun research or rewrite the immutable report. The task kind becomes `portfolio`/`daily_research` when readable, or `formatting_portfolio`/`formatting_daily_research` while pending.
- `CurrentResearchService.reconcile` can repair failed formatting receipts automatically when their saved material becomes readable. Recovery rechecks owner, visibility/revocation and the failed receipt's task kind/generation sequence before changing the current pointer, and marks an associated automatic task completed. Reformatting and reconciliation can write projection/receipt state: absence of a model call does not make them read-only smoke tests. This recovery change adds no database migration.

For archived simulation reviews, `SimpleReportReader` uses `shared/simulation-review-reading.ts` only for the known source-less `council` envelope with matching account/period identifiers and a valid saved review. It renders archived performance, fees, attribution, execution constraints and data gaps, keeps missing figures unknown, and retains the original snapshot. It neither unwraps unrelated JSON nor rewrites archived content. These reviews omit the execution-plan widget rather than inviting fresh research to invent a missing plan.

## Exact source → draft → explicit application

| User intent | Concrete entrypoint | Effect |
|---|---|---|
| Read the report's proposed plan | `client/src/components/ReportExecutionPlan.tsx`; `server/modules/research-documents/research-documents.controller.ts` | Read exact version and validated execution plan |
| Inspect source addition | `POST /api/investment-strategies/source-preview` | Resolve report version/section or released message into a bounded source snapshot |
| Import to a draft | `POST /api/investment-strategies/import-source` | `UserInvestmentStrategyService.importSource`; creates/reuses an exact-source draft, not a running policy |
| Add to a chosen draft | `POST /api/investment-strategies/:id/add-source` | Adds source and entries under expected revision; rejects incompatible proposed validity periods |
| Edit or deterministic preview | `PATCH /api/investment-strategies/:id`; `POST /:id/preview` | Updates draft revision; editing invalidates prior preview |
| Prepare an explanation | `POST /api/investment-strategies/:id/prepare`; `GET /:id/preparation` | Explicit, durable single-request claim; status read does not rerun the model |
| Apply after review | `POST /api/ai-investment/apply-strategy` | Atomic confirmation, policy activation, old-candidate cancellation and runtime installation |

The draft controller is `server/modules/paper-trading/user-investment-strategy.controller.ts`. The apply endpoint is in **`server/modules/paper-trading/investment-policy.controller.ts`**, calling `InvestmentPolicyService.applyStrategy` and then `UserInvestmentStrategyService.confirmInTransaction`. There is no substitute standalone strategy-confirm endpoint to guess. The client uses `client/src/api/investment-strategies.ts` and `client/src/api/ai-investment.ts`; Today source dialog/editor/section own the current review flow.

Source rules:

- Use exact `{ kind: 'report', versionId, sectionId? }` or `{ kind: 'message', messageId }`. The `execution-strategy` section revalidates the snapshot's typed plan; importing an arbitrary prose section supplies observation material, not inferred executable parameters.
- Freeze source key, content, readable content, content hash, capture time and original creation time. Report source must be owner-accessible, valid and available; progress events or unreleased/empty discussion messages are not usable opinions. Confirmed strategies are immutable; start a derived draft to change one.
- Preserve proposed periods and risk limits. A plan whose period does not fit an existing draft is rejected rather than silently clipped. `sourceAddition` in `user-investment-strategy.rules.ts` is the source-to-entry contract; only a `ready` report plan retains executable directives, while `needs_info` entries remain observations.
- Import is not authority. Automatic daily draft handoff is deliberately separate from the user's apply action.

Apply requires `{ strategyId, expectedRevision, previewHash, expectedCurrentId, requestKey }`. Within an owner-fenced transaction it checks the current pointer, draft revision, freshly derived preview, source validity and exact content hash. It cancels old investment candidates, changes policy revision/status, enables the paper account, installs the investor mandate and records decision context. Same-key changed requests conflict; repeated compatible requests return their receipt. A stale preview is a conflict, not a cue to silently recompute and apply without review.

## Hashes are different contracts

| Contract | Implementation | What must remain stable |
|---|---|---|
| Research content/submission identity | `contentHash` in `server/modules/research-documents/research-documents.rules.ts` | Recursively sorted object keys; array order retained; SHA-256 of JSON |
| Strategy source snapshot | `resolveSource` in `server/modules/paper-trading/user-investment-strategy.service.ts` | SHA-256 of exact saved source content string, distinct from the full report payload hash |
| Strategy confirmation preview | `strategyContentHash` in `server/modules/paper-trading/user-investment-strategy.rules.ts` | SHA-256 of `JSON.stringify({ content, sources })`; import derives preview from returned persisted JSONB, so pre-insert key order cannot produce a different confirmation hash |
| Investment action receipts | `investmentHash` in `server/modules/paper-trading/investment-policy.service.ts` | Canonical action payload plus owner-scoped request identity |
| Channel template/finding/delta | `server/modules/channel/channel-hash.ts`, `channel-contract.ts` | Canonical payload, exact template revision/hash, resolved slots, source revisions/evidence card and runtime dependency digest |
| Transaction import concurrency | `ledgerHash` in `server/modules/import/transaction-import.rules.ts` | Batch input and current ledger/positions/cash revision at preview/commit |

Do not consolidate these helpers based on similar names without reviewing stored records and compatibility. `previewHash` sent by the client is the saved strategy preview's `contentHash`, not a newly invented hash of displayed prose.

## Applied strategy → simulation

`server/modules/paper-trading/user-strategy-runtime.ts` converts confirmed preview directives to investor mandate rules and an internal builder profile. `strategy.scheduler.ts`/`strategy.service.ts` evaluate rules; `strategy-route.rules.ts`, portfolio-risk checks and `paper-trading.service.ts` control final order placement. Configured, currently effective, monitoring, awaiting review and filled are different states.

Keep these fences at the final transactional boundary:

- Owner, paper account, strategy/revision, policy/revision and mandate must still match; applying/replacing/pausing invalidates stale candidates.
- Respect directive validity, expiry, constraints, fresh usable quote, market session, sizing/cash/exposure limits and required AI/Council review. A successful report or approved sentence alone cannot bypass the order boundary.
- `ResearchDocumentsService.assertExecutionSourcesInTransaction` checks exact version/section references, revocation, source existence, availability time, future data and transitive frozen dependencies under the owner fence. Historical labels alone do not clear dependency failures.
- Pausing stops all automatic trading, including protective exits. Resume requires a confirmed user strategy and fresh evaluation. `StrategyMonitorService` records offline intervals instead of inventing fills during downtime.
- Fills update the **paper** account/positions/order/trade ledger. There is no broker order submission or automatic update to recorded real holdings/transactions. Compare `simulation-ledger.ts` with `server/modules/transactions/transactions.service.ts` before changing accounting.

## Channel publication is a separate pipeline

The current `/council` UI reads `/api/channel`; daily research transcripts are not its feed. `ExperienceScheduler` reconciles research, synchronizes published daily reports, ticks briefs and monitors owners. The durable publication types are in `shared/channel.interface.ts` and tables in `server/database/channel.schema.ts`.

Two source paths converge at a publication gate:

1. **Compiled brief:** `ChannelBriefsService` compiles current published report artifacts into registered templates. It checks report/version validity, same-day context, expiry and current strategy revision. Price-cross conditions require sourced typed thresholds and a resolved ticker; no ticker/threshold is inferred from prose. Dispatch is deterministic and does not start a model request.
2. **Background finding:** `ChannelService.ingestFinding` validates owner, episode, exact anchor, material semantic delta and evidence card through `sealFinding`. The server seal includes payload hash, dependency digest and compiler version. `no_counterevidence_found` cannot publish a finding; `unable_to_verify` requires a new material gap. Arbitrary model claims or an `approved` field cannot substitute for this seal.

`publishTemplate` or sealed finding rendering then passes `canPublish`, template/slot validation, freshness/correction checks and deduplication. `commitBubble` persists bubble, episode advance, applicable memory and `channel_outbox` rows in the same transaction. `poke` queues stream and notification destinations; lesser weights queue stream. This is durable application delivery, not a claim of exactly-once external notification receipt.

`channel-runtime.ts` and `channel-executions.ts` project confirmed/effective strategy and actual simulated executions. The UI must not imply a configured strategy is active or a signal is a fill. Channel actions are idempotent user decisions/navigation; they do not replace `/api/ai-investment/apply-strategy`. Questions use a bounded single-tool fact-check path, with deferred questions and interruption recovery, not an automatic full debate.

Personal memory also has provenance: `channel-memory.service.ts` saves an explicitly selected user's exact quote. System snapshots, absent adoption reasons (`unrecorded`) and later user reflections are distinct. Do not infer a user's reason or psychological state from strategy outcomes.

## Real asset ledger and imports

Real assets are recorded in holdings, transactions, closed positions and cash accounts. Screenshot holdings batches (`server/modules/import/import-batches.service.ts`) and transaction-file batches (`transaction-imports.service.ts`) are distinct operations. Both expose preview/commit flows in `server/modules/import/import.controller.ts`; preview is not commit.

Transaction imports classify broker/source identities and fingerprints, return batch and ledger revisions, and commit selected eligible rows only after rechecking both revisions under an owner lock. They call `TransactionsService.createInTransaction`, preserving source batch/raw-row provenance without nested commits or synthetic deposits. Insufficient cash and baseline/history conflicts need explicit correction; do not silently create cash to make an import pass.

`server/database/asset-ledger.schema.ts` stores position baselines and cash-confirmation receipts. Screenshot commits use `server/modules/import/position-checkpoint.ts` to record the checkpoint and covered ledger rows. `TransactionsService` reconstructs positions around baselines and protects already reconciled cash history. `CashAccountsService.confirm` uses request keys and expected update timestamps and records which transactions a confirmation covers. The retained paired cash-top-up endpoint represents a separate explicit user request; ordinary transaction/import paths must not inherit it.

`PortfolioMetricsService` reads recorded assets, quotes, FX and value points for Today. Keep source/time/coverage visible: recorded balances are not broker synchronization, quote retrieval is not exchange-live execution, missing FX/data is not zero. Import-to-research handoff in `server/modules/experience/import-analysis-handoff.service.ts` freezes analysis requests; it is not trading authority.

## Targeted verification

Use [development-and-tests.md](development-and-tests.md) for commands and disposable database setup. Relevant existing regression families include:

- Research: `server/modules/experience/daily-channel-research.integration.spec.ts`, `research-entry.integration.spec.ts`; `server/modules/council/` independent/daily/publication suites; `server/modules/research-documents/research-documents.integration.spec.ts`.
- Saved report recovery/reading: `server/modules/experience/report-recovery.integration.spec.ts` (requires `EXPERIENCE_TEST_DATABASE_URL`); `client/src/utils/current-report-recovery.test.cjs`, `simulation-review-reading.test.cjs`. Cover old daily receipts, exact returned-version links, owner/revocation boundaries, unchanged archives, unknown figures and no executor calls.
- Report/strategy boundary: `server/modules/paper-trading/user-investment-strategy-report.integration.spec.ts`, `user-investment-strategy-preparation.integration.spec.ts`, `user-strategy-order-boundary.integration.spec.ts`, `user-strategy-runtime.integration.spec.ts`.
- Channel: `server/modules/channel/channel-contract.spec.ts`, `channel-briefs.service.spec.ts`, `channel-durable.integration.spec.ts`; `client/src/utils/channel-workbench.test.cjs`.
- Real ledger: `server/modules/import/asset-ledger.integration.spec.ts`, `transaction-import.spec.ts`; `server/modules/transactions/asset-ledger.spec.cjs`; `client/src/utils/transaction-import.test.cjs`.
- Current UI import/apply: `client/src/utils/report-execution-plan.test.cjs`, `investment-strategy-source.test.cjs`, `strategy-preparation-flow.test.cjs`, `today-strategy-editor.test.cjs`.

For a contract change, update the affected diagram and this reference in the same change. If only presentation or an internal implementation changes, record a reasoned no-architecture-impact review rather than editing diagrams cosmetically. Do not verify by launching personal research, applying a live strategy or mutating an installation's ledger.

Operational read boundary: `readChannelRuntime` is a repeatable-read projection, but
`ChannelService.projection` also performs supplement recovery and preference
initialization. `GET /api/channel` is therefore not a strictly side-effect-free
probe. See [deployment-and-recovery.md](deployment-and-recovery.md).
