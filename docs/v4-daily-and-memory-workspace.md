# V4 daily, research, data and memory workspace

Reviewed against the V4 working tree on 2026-11-10. These are web routes; no production instance or paid research was used for verification.

## Routes and retained capabilities

| Route | Entry | Source |
| --- | --- | --- |
| `/daily` | `client/src/pages/Analysis/DailyReportPage.tsx` | `GET /api/daily-workspace?date=YYYY-MM-DD` |
| `/research` | `client/src/pages/Analysis/ResearchWorkspacePage.tsx` | Persistent `/api/research-conversations`; same-page chat and task history |
| `/research/portfolio` | `client/src/pages/Analysis/SimpleAnalysisPage.tsx` | Existing explicit current-research/start/recovery flow |
| `/analysis` | `client/src/pages/Analysis/ReportHistoryPage.tsx` | Saved immutable report versions; concise list only |
| `/data` | `client/src/pages/Workspace/DataCenterPage.tsx` | Existing integration settings, import batches, research archive jobs and model connections |
| `/memory` | `client/src/pages/Workspace/MemoryWorkspacePage.tsx` | `GET /api/research-memory/inventory?offset=0&limit=24`, existing channel preferences and council submission inventories |

`/analysis` is a concise saved-report list without statistic cards or complex filter controls. Existing date, source and topic URL context is retained when opening a row and returning. `/analysis/reports/:versionId` reads that exact immutable version; it does not substitute the newest report. Explicit portfolio research and its start/recovery controls live at `/research/portfolio`, reachable from workspace navigation and the daily page. `/council`, holdings, transactions, watchlist, journal, import and all previous settings remain reachable.

The research room contains a large conversation area and a permanent desktop history sidebar; mobile history opens in a drawer. Selecting a saved task changes `session` in the research-room URL and reads it in the same pane. The four capability-link cards are removed. `ArchivedCouncilPage` has an optional workspace mode that reuses existing persisted messages, member states, original input, recovery and stop controls. The legacy `/council` channel and its question links keep their existing behavior.

Sending is explicit, with portfolio context by default. A `question` URL parameter only prefills the bounded 2,000-character draft. Drafts and request identities are separate for each selected task and the new-question composer while the workspace remains open. An uncertain transport result retains the exact submitted payload and key; its original text stays locked until acknowledged or explicitly rejected. Selecting another history item during delivery does not get overridden when the original receipt arrives. Choosing an example only fills the composer.

Each historical task has a small delete action with one confirmation. `POST /api/research-conversations/:id/delete` uses `expectedRevision` and `requestKey`; confirmed deletion removes only that task and clears the selected pane when needed. Saved original reports and trading records remain. Running or provider-uncertain work is rejected with `RESEARCH_DELETE_REQUIRES_SETTLEMENT`; the user must explicitly stop and settle it first. Revision conflicts require refreshing the history before a new confirmation.

The daily page first shows personal ledger results and each independent simulation, then saved personal research, discussion differences and next checks. Each account has a trading-daily viewing layer. Personal facts and exact-version research also open in closeable layers, keeping the underlying date/list context. The daily overview contains no report-history list or older-overall-report expansion; history is available separately at `/analysis`.

## Read-only daily projection

`server/modules/experience/daily-workspace.controller.ts`, `.service.ts` and `.rules.ts` own the endpoint; `ExperienceModule` registers it. The shared contract is `shared/daily-workspace.interface.ts`; the client transport is `client/src/api/workspace.ts`.

- The ledger portion uses a PostgreSQL repeatable-read, read-only transaction. It does not refresh quotes, write valuations, stage model work, execute an order or retry notifications.
- The reporting day is explicitly **Asia/Shanghai**. Personal facts reuse `capturePortfolioDailyFacts`; the response records the actual `readAt`/`capturedAt`. Historical ledger facts are a fresh reading of currently saved records, not a newly frozen historical FactBundle.
- Owner-scoped paper accounts include paused and archived records that existed on the selected date. Current account status and current companion identity are presentation metadata, not claims about historical status or strategy authority.
- Fills come from **all matching `paperTrades` rows**, grouped by fill `createdAt`, not order creation and not a recent-feed limit. Currency is resolved through an owner/account/order-matched order. Trade price retains the order currency; the recorded fee is **USD**, as written by the execution ledger.
- Unexecuted entries are all current non-filled statuses of orders created on that reporting day, including pending, pending approval, failed, risk rejected and cancelled. Their individual statuses and stored reasons remain visible. Observations that never created an order are not silently counted as unexecuted orders.
- Account equity/cash are saved date snapshots. Daily profit requires trusted timestamps on exact neighboring dates, a reconciled equity difference, and no later fill. Missing/stale/inconsistent boundaries remain unknown. Account snapshot dates use the account risk timezone; a different day boundary from Asia/Shanghai is an explicit gap and its daily profit is not mixed into the report.
- Real and simulated funds are never added into one asset total. Missing values render as `—`, not zero. A date snapshot is not labelled an official market close.
- `CurrentResearchService.getDailyReports` separately reads immutable initial and latest discussion versions. New discussion conclusions do not replace the initial finding. Evidence layers use `fetchResearchDocument(versionId)` without resolving a latest pointer.

The projection remains usable without AI. The separate explicit overall-summary flow below freezes this projection only when requested. Weekly/monthly generation and sharing remain separate product work.

## Explicit overall daily research

`DailyWorkspaceResearchService` and `DailyWorkspaceResearchController` expose `GET /api/daily-workspace/research?date=YYYY-MM-DD` and `POST /api/daily-workspace/research` with strict `{date, requestKey}`. The GET only reads saved state. The POST rejects future/invalid dates and owner/facts overrides; it delegates to the existing `SimpleCouncilService` private daily pipeline, retaining sealed independent submissions, the mandatory reverse check, central model budgets and publication fences.

The internal `overallDaily.capture` supplier runs only after the durable owner/request receipt lookup. It freezes the complete ledger projection without its opinion/report field, plus up to the latest five available saved personal-portfolio inputs dated on or before the report day. Each historical input retains its exact version ID and snapshot; missing history remains an explicit gap. Historical dates exclude current holdings. Today's generation also captures current stored holdings/cash with their read time, explicitly without claiming exchange-close accuracy. These are history coverage limits, not invented historical positions.

One atomic `Frozen owner context` evidence item contains `OverallDailyEvidence` exactly. Existing API/native-context budget gates may reject oversized context; they cannot silently excerpt the mandatory account records. The independent-release barrier now preserves mandatory owner evidence when later sources fill the bounded report evidence inventory. Every phase receives the same content and hash. The checkpoint and immutable report snapshot retain `overallDaily: {date, timezone: 'Asia/Shanghai', readAt, factsHash}`. The model is instructed to keep real and simulated capital separate, explain every account's fills/fees/unexecuted reasons/failures/gaps, avoid rankings across different starting points and lead with a one-minute synthesis.

Overall reports are queried separately. They are excluded from `CurrentResearchService.getDailyReports` initial/discussion selection and from automatic channel/strategy handoff. Publication does not create an account strategy or authorize a trade. Original personal reports stay unchanged. The daily page exposes explicit generation, progress, exact evidence and the existing task recovery UI; closing recovery/evidence retains the report date. Earlier versions are read from the separate report-history list. An unconfirmed browser request retains its receipt key for retry. No page mount invokes a model.

History uses the immutable version marker, not the current mutable session checkpoint. Generic rerun/message/fork APIs cannot convert an overall task to an ordinary discussion or restart its completed independent work. New overall generation starts through its explicit endpoint. Existing native result continuation and the added API challenge/summary continuation use `resume-report` with the original cycle/turn, expected revision and durable request receipt; budget and source checks remain active. A mocked API-summary failure is resumed without replaying the three completed openings or reverse check. The recovery layer is pinned to an allowed session for the selected date and hides new/discussion-switch/composer controls. Successful continuation invalidates the overall projection so progress polling resumes. Overall archives are filtered out of automatic personal handoff **before** its 40-row window.

If all original openings fail, explicit member recovery preserves their sealed submissions. Once every member is terminal and at least one submission is accepted, explicit report continuation releases that original barrier and dispatches only the remaining check/synthesis. Each recovered opening is published and counted once. A process exit after the request receipt commits but before dispatch leaves the same frozen task recoverable: startup exposes a paused task without any model call; explicit continuation validates that no attempt/submission exists and starts the original cycle. Startup, GET and replay of the create receipt never implicitly dispatch an overall request.

## Global memory inventory and controls

`ResearchMemoryService.inventory` lists non-deleted source memories for the current owner, newest first with a stable ID tie-break, bounded to 1–100 sources per page. `offset` is nonnegative and bounded. The endpoint does not accept an owner override. It returns each page's current non-deleted theses through existing source/evidence materialization, retaining unavailable-source handling.

The workspace labels page-level claim counts as page-level counts. It distinguishes:

- candidates, research-accepted claims and **user-confirmed** claims;
- excluded, dismissed and expired claims;
- research symbol/market/topic, source version/date, current thesis version and expiry;
- explicit personal preferences from the channel and account-authoritative strategy constraints.

The detail layer composes the existing `CouncilMemoryPanel`, `MemoryEditorSession`, versions and monitor controls. Confirmation/edit/exclusion retains the existing expected-version checks and server provenance. Source report/trade history is not rewritten.

A selected paginated source or claim uses the existing owner-validated by-ID read, rather than the recent ticker list (which can omit old candidates after 100 sources). The detail is current when editing, mutations invalidate its exact query, and read/access failure does not display a stale cached selection.

The usage view selects an actual council task and displays saved `CouncilMessage.memory` inventories via `CouncilMemoryInventory`. Requested/selected/prepared/submitted stages and omissions stay distinct. Submission does not prove model use; native private context and older missing inventories remain unknown. No synthetic “times used” counter is introduced.

Legacy channel preferences are visible with their exact user quote and source time. Their old API has no edit/exclusion operation or full version lifecycle; the UI states that limitation. Research-thesis editing/exclusion is operational. A separate preference lifecycle API would be required to extend those controls to legacy channel preferences.

## Data-center boundaries

The three views display existing source configuration, saved-ledger gaps and real processing records. Import batch detail shows filenames, recognized rows, field issues and posting receipts. Research archive jobs preserve their stored success/failure/attempt state. A configured integration is not described as recently refreshed. The page does not invent a generic connector/field-mapping API, active health test, document upload pipeline, backup/restore function or external-tool capability.

## Verification

New suites:

- `server/modules/experience/daily-workspace.rules.spec.ts`: actual fill facts, unknown fees, neighboring valuation reconciliation and date validation.
- `server/modules/experience/daily-workspace.integration.spec.ts`: isolated owners, 25 fills without recent-feed truncation, previous-day order/current-day fill, currency/fee distinction and read-only projection.
- `server/modules/experience/daily-workspace-research.integration.spec.ts`: real sealed-independent/reverse-check/publication services with stub models; all phase inputs identical, owner/history boundaries, actual pending/failed orders, no old-report replacement, durable retry without recapture/model calls, visible budget failure, safe same-cycle summary/barrier recovery, unique recovered messages/usage, and crash-before-dispatch recovery without startup calls.
- `server/modules/research-memory/research-memory.inventory.spec.ts`: bounded strict query parsing, including rejection of owner overrides.
- `server/modules/research-memory/research-memory.inventory.integration.spec.ts`: source pagination and cross-owner isolation.
- `client/src/utils/workspace-v4-render.test.cjs`: independent accounts and research versions, unknown values, accepted-versus-confirmed memory, truthful connection status and retained routes.
- `client/src/utils/workspace-v4-flow.test.cjs`: closing account/evidence layers retains the selected report date; import details return to the processing list; preference and missing-submission records stay truthful; research handoff never sends and never replaces an unsent channel question; idle/failed/paused overall recovery is explicit, retries the same receipt/revision, retains the date and changes to the running view after success.

The independent V4 navigation review also corrected explicit hash links (including a first direct visit), retained saved Back scroll positions including zero, treated `/settings/models` as the settings root, and passed the active settings section to extracted cards so hidden panels cannot keep portals open. `workspace-navigation.test.cjs` covers these route/scroll decisions. `strategy-interview-flow.test.cjs` independently covers six DOM flows: create/save/resume/accept/preview/stage, save failure retry, edited-field recovery, an accepted request whose response was lost across reload, invalidated old previews and server revision conflicts. Interview fixes are maintained by the interview owner.

Use verified disposable database URLs only:

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/experience/daily-workspace.rules.spec.ts server/modules/experience/daily-workspace.integration.spec.ts server/modules/experience/daily-workspace-research.integration.spec.ts server/modules/research-memory/research-memory.inventory.spec.ts server/modules/research-memory/research-memory.inventory.integration.spec.ts
node --test client/src/utils/workspace-v4-render.test.cjs client/src/utils/research-memory-render.test.cjs client/src/utils/research-memory-lifecycle.test.cjs client/src/utils/report-history-render.test.cjs client/src/utils/report-kind-reading.test.cjs
node --test client/src/utils/workspace-v4-flow.test.cjs client/src/utils/workspace-v4-render.test.cjs client/src/utils/strategy-interview-flow.test.cjs client/src/utils/workspace-navigation.test.cjs
```

The database suites use `EXPERIENCE_TEST_DATABASE_URL` and `MEMORY_TEST_DATABASE_URL`, create isolated fictional schemas and drop only those schemas. A missing environment variable is a skipped integration, not a pass. Local ESLint, CSS lint, type checks and architecture checks complement these suites. Browser/visual acceptance and the final root-level build/context results are recorded in the overall V4 delivery.

On 2026-11-10 the four fact/inventory server suites passed **8/8** and the explicit overall research suite passed **7/7**, all with zero skips, using the disposable `v4_memory_tests` database on local port **55472**. Existing native report continuation and conversation-entry integration suites then passed **15/15**. The combined eight client suites in the commands above passed **49/49**, including the six interview flows, four navigation cases and exact old-memory selection; after adding the three-state recovery scenario, the updated workspace flow suite passed **6/6**. Both client and server `npm run type:check` and targeted ESLint passed after the final recovery changes. No production database or service on 3190 was used, and every model response in integration tests came from a stub.

## 架构影响核对

新增日报事实为 Experience 内的只读聚合，新增记忆清单为 ResearchMemory 内的 owner 隔离读接口。总体研究为单独显式 POST：完整事实 + 有界历史个人输入 → owner/request 幂等 → SimpleCouncil 封存独立分析 → 反向核查 → 不可变总体版本；读取页面不会自动执行此链。没有新增后台调度、交易授权或账本写路径。总体版本通过 `snapshot.overallDaily` 与原始持仓 initial/discussion 分离，也不进入自动频道/策略导入。系统入口图需增加 `/daily`、`/research`、`/data`、`/memory`；报告图应分别标注“实时只读投影”“明确生成时冻结证据”“不可变总体版本”，同时保留原持仓日报读写链。
