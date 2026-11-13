# Development and test selection

Use the selected checkout's `package.json`, `.github/workflows/ci.yml`,
`CONTRIBUTING.md` and `docs/development.md` as command authority. Resolve the
checkout first with `inspect-workspace.cjs --repo <root>`; the installed skill
may describe an older revision. Run commands below from that root.

## Source development

Node >= 22, npm >= 10 and PostgreSQL 16 are the current prerequisites. Run
`npm ci` when dependencies are absent or the lockfile changed. Initialize
`scripts/db/01_schema.sql` only on a newly created, empty development database.
Keep credentials in ignored `.env.local`; use `.env.example` for supported
variables. `npm run dev` loads shell values first, then `.env.local`, then
`.env`, and starts the backend and Vite. Default ports are 3000 and 8080.

The supervisor in `scripts/dev.js` and `scripts/dev-processes.cjs` supports
Windows and POSIX. It can terminate existing listeners and their supervisors
on its configured ports. Discover ownership before starting it; choose separate
ports and database for a development checkout next to a live installation.
Changing `CLIENT_DEV_PORT` also requires matching `LOCAL_APP_ORIGINS`.
The standalone `dev:server` and `dev:client` commands do not load the
supervisor's dotenv files. Logs are in `logs/` (or `LOG_DIR`).

For a private source release use `npm run build:web`. `npm run build` also
builds Electron, outside the current web-only phase. Backend startup applies
registered migrations and starts background services; it is not a read-only
smoke test. Use the [deployment runbook](deployment-and-recovery.md) for an
existing instance, not `npm run dev` or an ignored temporary helper.

## Choose checks by changed behavior

Overview alignment and five-minute capture: run the `portfolio-valuation` and
`portfolio-sampling` experience suites, `quote/us-observed-quote.spec.ts`,
`portfolio-history/*spec.ts` and paper comparison suites against disposable
`EXPERIENCE_TEST_DATABASE_URL`, `HISTORY_TEST_DATABASE_URL` and
`STRATEGY_TEST_DATABASE_URL`. Verify expiry after waiting on locks, concurrent
inventory edits, unchanged quote deduplication, unknown capture persistence,
stable partial references, quote-time/FX lookahead and downsampling boundaries.
After `build:client`, run `node scripts/ui-probe/overview-layout-browser.cjs`
for wide/mobile, theme/language, card/footer and existing-logo acceptance. The
chart behavior tests include real endpoint-only bridge layers, return isolated
points and date-only versus genuine intraday tooltip/source evidence.

Desktop density and research-pane acceptance: `npm run build:client` then
`npm run ui:density` renders18 fictional browser scenarios and asserts first-screen
chart coverage, visible composers and separate message scrolling. `--dist <dir>`
can verify that a prior compiled client fails the same assertions.

Team removal reuses archive-preview/archive. Run
`server/modules/teams/teams-archive.integration.spec.ts` and
`server/modules/team-runs/team-run.integration.spec.ts` with a disposable
`TEAM_TEST_DATABASE_URL`, plus `client/src/utils/team-removal.test.cjs`.
Verify agreement snapshot/revision fences, atomic pause and reserved-cycle
cancellation, handover/replayed old pause isolation, final-apply races, retained
financial/report history and exact unknown-request retries. Do not archive a
personal team or start a real Agent as a smoke test.

For measured UI alignment and responsive-control fixes, use the frozen fictional
matrix and commands in [.ui/README.md](../../../../.ui/README.md). Run
`npm run test:ui-probe` for detector, fixture and improvement-gate contracts.
`npm run ui:probe` scans only the dedicated loopback fixture, never a personal
backend. Capture before and after with the same detector, matrix, browser and
token fingerprint; missing scenarios and new serious findings fail the gate.
Run-local evidence is not a human-approved visual baseline. Keep intentional
horizontal scrolling and supported multiline controls distinct from clipping.

Agent tooling (migrations53–58) uses `RESEARCH_TEST_DATABASE_URL` plus
`TOOL_CONNECTIONS_TEST_DATABASE_URL`, both disposable PostgreSQL16. Include
`research-runtime/*.spec.ts`, `research-runtime/drivers/*.spec.ts`,
`tool-connections/*.spec.ts`, `tool-connections/providers/*.spec.ts`,
`tool-actions/*.spec.ts`, `research-artifacts/*.spec.ts`,
`research-compute/*.spec.ts`, `research-core/model-step.spec.ts`,
`research-tools/research-portfolio.integration.spec.ts`,
`council/council-api-tools*.integration.spec.ts`, `data-library/documents/*.spec.ts`,
`data-library/providers/*.spec.ts` and new dataset/document integration cases.
They test actual SDK/MCP and durable database paths with fake transports, including
approval edits, unknown calls, zero usage, source revocation and late receipts.
Browser fixtures use actual Chromium. Python analytics uses actual pinned
QuantStats/Backtrader: `uv sync --project workers/analytics --frozen`, then
`uv run --project workers/analytics python -m pytest workers/analytics/tests -q`.
Do not replace missing live OCR/cloud prerequisites with a skipped “pass.”
Explicit provider probes can charge money; status GETs and driver preferences
must not send model requests. New settings/artifact flows need fictional UI
acceptance at desktop1440/mobile390. See `docs/agent-tooling.md` for limits.

Transport lifecycle changes include `tool-connections/tool-transport.spec.ts`:
exercise nonempty HTTP202 notification cancellation, partial reads, aborts and
response limits on supported Node versions. Preserve pinned DNS, TLS, exact
private-service allowlists and redirect rejection. Source-host deployment needs
actual Docker Desktop loopback reachability through the fixed relay plus proof
that worker networks remain internal-only; a configuration-only port assertion
does not establish connectivity. Use fictional services/accounts for invocation
checks, then metadata-only checks on an authorized personal deployment.

V5 data-library tests are included in `test:server` and require the disposable
`RESEARCH_TEST_DATABASE_URL`. They exercise source ownership/version lifecycle,
SSRF/redirect and extraction limits, credential isolation, sync recovery and actual
financial-adapter consumption with fake transports. `client/src/utils/data-library-flow.test.cjs`
checks write-only credentials, exact historical-version navigation and deletion.
Research skill and conversation suites cover explicit selection, frozen pins,
per-member native tool scopes and material dependencies. No test needs a real
subscription password or live model session.

V4 focused checks include `client/src/utils/strategy-interview*.test.cjs`, `workspace-navigation.test.cjs`, `workspace-v4-*.test.cjs`, `companion-creation-flow.test.cjs` and `integrations-reachability.test.cjs`; server interviews, frequency, companions, custom/copy seeds, daily-workspace and memory-inventory suites use disposable URLs. Interview cases cover exact raw wording, explicit acceptance, edited/stale reviews, read-only observation restoration and lost-response receipts across reload. Frequency tests exercise both claim and final order locks. Update `assets-upgrade.integration.spec.ts` alongside migrations 46/47 so fresh-versus-upgraded catalogs and unchanged ledgers are actually compared. Node fake time does not change PostgreSQL CURRENT_TIMESTAMP; set explicit fixture opening/fill timestamps for corporate-action and historical-window checks.

Browser acceptance should check desktop visibility of `.app-topbar`, real route/query/scroll restoration, directly opened details, hash links, mobile fixed save/return, closed dialog context and saved conversation reload. A passing pure route unit test does not prove the old stylesheet did not hide the controls. The live personal instance is not a UI fixture.

Run `npm run lint` for application/tool changes. Before a PR, application
changes require the server, client and local-agent suites described in
`CONTRIBUTING.md`; the table narrows the fast feedback loop, not required CI.
Use fictional fixtures and disposable state. No paid research, personal native
provider sessions, real portfolio writes or live strategy confirmations.

| Area | Focused feedback and relevant suite |
|---|---|
| Current analysis/report import | `server/modules/experience/*integration.spec.ts` (including `report-recovery.integration.spec.ts`), `server/modules/research-documents/*.spec.ts`, `client/src/utils/current-report-recovery.test.cjs` and `simulation-review-reading.test.cjs`; `npm run test:server`, `npm run test:client` |
| Complete frozen account input and saved-daily continuation | `server/modules/council/council.owner-context.spec.ts`, `council.context.spec.ts`, `council.daily.spec.ts`, `council-report-resume.integration.spec.ts`; `client/src/utils/resume-daily-report.test.cjs`. Check full owner JSON, pre-dispatch refusal, retained openings, original native task identity, corrected reverse-check selection and same-intent retries. The resume integration asserts a disposable `COUNCIL_TEST_DATABASE_URL`; absence fails rather than counts as a pass. |
| Completed native output awaiting acceptance | `server/modules/council/council-report-resume.integration.spec.ts`, `council.daily.spec.ts`. Distinguish successful provider completion from local parse/acceptance; reparse the exact saved result with no provider replay, preserve original turn/call accounting and permit only a needed later summary call. Cover owner/task/frozen-input/prompt/result-hash mismatch, repeated requests, retained correction coverage and exact current-projection fences. A saved challenge needs only the next summary call; a saved summary needs zero. Reverse-check citations must accept valid twenty-one through sixty IDs while rejecting unknown IDs or sixty-one entries. Integration uses a disposable `COUNCIL_TEST_DATABASE_URL`. |
| Simulation review observations and report category | `server/modules/paper-trading/simulation-review.integration.spec.ts`, `simulation-experiments.integration.spec.ts`; `client/src/utils/simulation-review-reading.test.cjs`, `report-kind-reading.test.cjs`. Run with a disposable `STRATEGY_TEST_DATABASE_URL` for initialization-only, later equal NAV, missing timestamps and strategy-boundary cases; reading tests retain immutable old numbers with coverage warnings. |
| Report-to-strategy confirmation and execution | `report-execution-plan.spec.ts`, `report-execution-runtime.integration.spec.ts`, `user-investment-strategy*.spec.ts`, `user-strategy-*.spec.ts` in `server/modules/paper-trading/`; corresponding `client/src/utils/report-execution-plan.test.cjs` and strategy tests |
| Report source readability and long observation imports | `server/modules/paper-trading/strategy-source-reading.spec.ts`, `user-investment-strategy.rules.spec.ts`, `report-source-import.integration.spec.ts`; `client/src/utils/investment-strategy-source.test.cjs`. Check shared placeholder/metadata filtering and public links, exact paragraph/Unicode reconstruction, 200000 raw/readable and 12000 entry bounds, preserved source key/hash, no model/directive/mandate inference, consistent twenty-source/twenty-entry preview/save gates, specific errors/reselection and unchanged typed-plan validation. The report-source integration requires and asserts a disposable `STRATEGY_TEST_DATABASE_URL`. |
| Channel publication, deduplication and recovery | `server/modules/channel/*.spec.ts`, `server/modules/experience/daily-channel-research.integration.spec.ts`, `client/src/utils/channel-workbench.test.cjs` |
| Real asset/transaction import | `server/modules/import/asset-ledger.integration.spec.ts`, `import-batches*.spec.ts`, `transaction-import.spec.ts`; `server/modules/transactions/*.spec.cjs`, `client/src/utils/transaction-import.test.cjs` |
| Auth/settings/owner isolation | Relevant `server/modules/auth/` and `server/modules/settings/` tests plus client auth/settings tests; run database cases |
| Memory/research workflow | `npm run test:server` and `npm run test:memory-eval` with required database variables |
| Native research and pairing | `npm run test:local-agents`; fixture executables and disposable task directories |
| Native model readiness versus actual dispatch | `server/modules/local-agents/execution-readiness.spec.ts` and `local-agents.service.spec.ts`: assert a uniquely resolved OpenCode default survives route, validation, journal staging and real `researchInvocation` argv; preserve variants, reject ambiguous defaults before staging and retrieve old tasks without redispatch. Use fixture runtimes rather than paid model calls. |
| Real-holdings copy into the current simulation | `client/src/utils/holdings-copy-journey.test.cjs` retains the earlier single-account page regression with `seedReal=1`; current independent-account creation is covered by `portfolio-workspace.test.cjs`. The retained journey checks: delayed setup, existing-account fence, StrictMode, errors/retry, cancellation, late responses and query preservation. `server/modules/paper-trading/simulation-experiments.preview.spec.ts` checks bounded quote concurrency, parallel FX and unchanged missing-data/source semantics. Run the simulation/investment-policy integration suites with a disposable strategy database. Browser acceptance can intercept every `/api/` request with fictional fixtures; navigation must issue one preview and no account mutation before confirmation. |
| Startup or process management | `npm run test:dev`; inspect Windows/POSIX ownership semantics |
| Account workspace and restart migration | `server/modules/paper-trading/portfolio-workspace.integration.spec.ts`, `portfolio-legacy.integration.spec.ts`, `portfolio-workspace.rules.spec.ts`, `legacy-builder-boundary.integration.spec.ts`. Cover independent creation, owner/account isolation, stale preview/revision, idempotency, archived/unmanaged guards, immutable history and a full migration replay after two active accounts exist. Migration 45 preserves scoped legacy index names; migration 42 must not stop valid combinations. Use `STRATEGY_TEST_DATABASE_URL`. |
| Account combination execution and capacity | `server/modules/paper-trading/portfolio-runtime.integration.spec.ts`, `portfolio-capacity.integration.spec.ts`, `strategy-allocation.spec.ts`, plus existing final-order/race/portfolio-risk suites. Check pause A versus running B, protections, shared cash/reservations, filled-entry replay, tightest limits, 100 enabled execution symbols and unchanged twenty-symbol per-market non-fixed daily AI cap. |
| Saved real/simulation comparison | `server/modules/paper-trading/portfolio-comparison.integration.spec.ts`, `portfolio-comparison.rules.spec.ts`; `client/src/utils/portfolio-comparison.test.cjs`. Check read-only transactions, foreign IDs, initial-only/missing/estimated observations, distinct inception, cash-flow/baseline discontinuity including hidden intraday changes, UTC windows and daily sampling. The integration uses `STRATEGY_TEST_DATABASE_URL`; it must make no valuation/research writes. |
| Account channel projection and navigation | `server/modules/channel/channel-workspace.integration.spec.ts`, `channel-durable.integration.spec.ts`; `client/src/utils/channel-account-selection.test.cjs`, `channel-workbench.test.cjs`. Check selection without preference/recovery writes, account-filtered bubbles/notifications, same strategy on two accounts, source rule publication recheck and exact fill links. |
| Account and report UI journeys | `client/src/utils/portfolio-workspace.test.cjs`, `portfolio-combination-flow.test.cjs`, `portfolio-combination-cache.test.cjs`, `report-execution-plan.test.cjs`. Cover creation/retry, disabled report staging, account-aware query invalidation, editor revision handoff, fresh preview requirement, budgets and independent account control. Browser acceptance must use fictional API interception or a disposable account. |
| Schema/migration/package changes | Fresh-schema and existing-schema upgrade checks; affected database suites and `server/modules/experience/migration-packaging.spec.ts`; `npm run build:web` or Docker build as relevant |
| Skill or context helpers | `npm run test:context`, `npm run check:context`; frontmatter, links and scenario verification |
| Research infrastructure and executor routing | `server/modules/research-core/*.cjs`, `server/modules/research-core/*.spec.ts`, `server/modules/research-routing/*.spec.ts`; the routing integration suites need disposable council/experience databases. Check retained pipeline/settings consumers too; `npm run test:server` includes all moved files. |
| Module dependency directions | `npm run test:architecture` exercises the actual ESLint configuration with allowed/forbidden static imports, type imports and re-exports. `npm run lint` enforces the same rules on production code. These checks do not validate runtime DI or dynamic imports. |
| Nest provider ownership | `npm run test:wiring` compiles the server and resolves the actual application providers using an explicit disposable `WIRING_TEST_DATABASE_URL` with the base schema initialized. It verifies a single routing/evidence/context provider owner, uses a temporary native-task directory, then closes the app and pool. It never calls `init` or `listen`, so scheduler bootstrap and real research do not run. Startup migrations still run on that disposable database. |
| Documentation only | Verify local links, commands against source, Markdown/Mermaid rendering and affected knowledge references; no unrelated local application test run is needed |
| Optional Python `agent/` | In `agent/`: `uv sync`, then `uv run pytest -q` |

For a specific suite, use the installed runner and match the npm script's
TypeScript configuration without a network install:

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/channel/channel-contract.spec.ts
node --test client/src/utils/channel-workbench.test.cjs
```

Keep scenario dates and service clocks consistent. A fixed transaction or report
business date must not be combined with live `new Date()` checkpoints. Freeze
only `Date` with the Node test context for deterministic dated fixtures, preserving
network timers; calculate business dates in the explicit account timezone. Include
stale-day rejection coverage rather than relaxing expiry or ledger baseline guards.

Do not broaden/repeat passing suites without a new change or unresolved risk.
Report database skips explicitly; an offline pass does not prove integration
coverage. Required GitHub checks remain **Lint & typecheck**, **Agent tests**,
and **Docker image build**, including documentation PRs. Desktop checks and
installers are paused unless desktop development is explicitly resumed.

## Disposable database setup

CI sets seven variables: `BUDGET_TEST_DATABASE_URL`,
`COUNCIL_TEST_DATABASE_URL`, `AUTH_TEST_DATABASE_URL`,
`STRATEGY_TEST_DATABASE_URL`, `MEMORY_TEST_DATABASE_URL`,
`RESEARCH_TEST_DATABASE_URL`, and `EXPERIENCE_TEST_DATABASE_URL`.
Channel integration accepts `CHANNEL_TEST_DATABASE_URL`. Fallback is suite-specific:
`channel-durable.integration.spec.ts` uses `STRATEGY_TEST_DATABASE_URL`, while
`channel-briefs.service.spec.ts` uses `COUNCIL_TEST_DATABASE_URL`. For focused
channel verification, set `CHANNEL_TEST_DATABASE_URL` explicitly to the disposable
database so both suites execute. The account workspace and question suites
(`channel-workspace.integration.spec.ts` and
`channel-question-account.integration.spec.ts`) use `investmentFixture` and require
`STRATEGY_TEST_DATABASE_URL` even when `CHANNEL_TEST_DATABASE_URL` is set. Set both
for a complete focused channel run. `CHANNEL_TEST_DATABASE_URL` is not an eighth
CI assignment.

Point these only at an isolated disposable database. Suites create/drop schemas
or mutate rows; sharing a URL with personal data is unsafe even when a test uses
a temporary schema. The following assumes a dedicated PostgreSQL 16 test cluster
and a newly created `squabble_test` database, using CI's fictional credentials:

```powershell
$squabbleTestUrl = 'postgres://postgres:test-only@127.0.0.1:5432/squabble_test'
psql --dbname $squabbleTestUrl -v ON_ERROR_STOP=1 -c 'SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), version();'
# Confirm this is the disposable target before initializing it.
psql --dbname $squabbleTestUrl -v ON_ERROR_STOP=1 -f scripts/db/01_schema.sql
if ($LASTEXITCODE -ne 0) { throw 'Fresh schema failed' }
$registry = Get-Content -Raw -LiteralPath 'server/common/platform/database.provider.ts'
$migrations = [regex]::Matches($registry, "'(\d\d_[^']+\.sql)'")
if ($migrations.Count -eq 0) { throw 'No registered migrations found; inspect provider' }
foreach ($match in $migrations) {
    psql --dbname $squabbleTestUrl -v ON_ERROR_STOP=1 -f (Join-Path 'scripts/db' $match.Groups[1].Value)
    if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($match.Groups[1].Value)" }
}
$testVariables = @(
    'BUDGET_TEST_DATABASE_URL', 'COUNCIL_TEST_DATABASE_URL',
    'AUTH_TEST_DATABASE_URL', 'STRATEGY_TEST_DATABASE_URL',
    'MEMORY_TEST_DATABASE_URL', 'RESEARCH_TEST_DATABASE_URL',
    'EXPERIENCE_TEST_DATABASE_URL'
)
foreach ($name in $testVariables) {
    [Environment]::SetEnvironmentVariable($name, $squabbleTestUrl, 'Process')
}
npm run test:server
npm run test:memory-eval
```

Read the provider before using this extraction if its format changes. Its
explicit list is the startup upgrade authority; numbering is not contiguous. Do not invent a
numeric migration range or glob in demo seed `02_demo_seed.sql`.
`01_schema.sql` is the consolidated fresh-install schema, not an upgrade
script. Startup does not create it and does not maintain a migration-version
ledger; it executes the registered additive SQL. Inspect actual tables/columns
and migration output rather than treating the maximum filename as DB version.

Some integration suites build an independent schema themselves. CI's explicit
bootstrap list is a test fixture setup, not the runtime upgrade registry.
`test:memory-eval` requires both memory and council URLs and fails on missing
prerequisites or skipped required coverage; inspect its JSON result as well as
the exit code. Never start the full app merely to initialize a test database.

For the daily simulation journey, also run `client/src/utils/simulation-journey.test.cjs`, `strategy-management.test.cjs`, the report/source/editor tests, and `server/modules/paper-trading/user-strategy-removal.integration.spec.ts`. The latter covers additive migration 44, owner/revision fences, deletion/preparation races, cancellation and retained history. Channel durable/brief suites cover visible full fills, replay, removed drafts, strategy-context recompilation and observation-only status. Use a separate fictional UI database for browser setup/import/apply/edit/remove flows while integration suites run.

## Portfolio-workspace upgrade and targeted commands

Migration 45 is registered in `server/common/platform/database.provider.ts` and included by `scripts/db/sync-fresh-schema.cjs`. The provider replays all registered SQL on every connection startup. An upgrade test must retain two running accounts and their account-bound profiles while replaying migrations 03, 28, the compatibility-adjusted 42, and 45. Testing 45 alone misses singleton-index recreation and unwanted pause/cancellation. Preserve old index names with new scoped definitions and confirm archived accounts stay archived; do not run an old binary against populated multi-account state as a rollback test.

With `STRATEGY_TEST_DATABASE_URL` already set to a verified disposable database:

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/paper-trading/portfolio-workspace.rules.spec.ts server/modules/paper-trading/portfolio-workspace.integration.spec.ts server/modules/paper-trading/portfolio-runtime.integration.spec.ts server/modules/paper-trading/portfolio-capacity.integration.spec.ts server/modules/paper-trading/portfolio-legacy.integration.spec.ts server/modules/paper-trading/legacy-builder-boundary.integration.spec.ts server/modules/paper-trading/portfolio-comparison.rules.spec.ts server/modules/paper-trading/portfolio-comparison.integration.spec.ts server/modules/paper-trading/strategy-allocation.spec.ts server/modules/channel/channel-workspace.integration.spec.ts
node --test --test-concurrency=1 client/src/utils/portfolio-workspace.test.cjs client/src/utils/portfolio-combination-flow.test.cjs client/src/utils/portfolio-combination-cache.test.cjs client/src/utils/portfolio-comparison.test.cjs client/src/utils/channel-account-selection.test.cjs client/src/utils/report-execution-plan.test.cjs
```

These focused commands complement required `npm run lint`, server/client/local-agent suites, `npm run test:architecture`, `npm run test:wiring` with `WIRING_TEST_DATABASE_URL`, `npm run build:web`, `npm run test:context` and `npm run check:context`. Record actual outcomes and database skips; source documentation is not evidence these suites were run.

Imported-portfolio refinement tests: `client/src/utils/holdings-loading.test.cjs`, `portfolio-reference-display.test.cjs`, `portfolio-history-flow.test.cjs` (see actual test inventory); `server/modules/portfolio-history/*.spec.ts` requires `HISTORY_TEST_DATABASE_URL` pointing to a disposable PostgreSQL database. Migration48 must be present in upgrade/fresh catalog parity checks. Public-provider smoke tests are separate from offline financial fixtures and never invoke models. Browser checks include immediate saved rows, background month lookback and current amounts, failed-reference recovery to saved records, UTC reference dates, list deletion and compact immutable report reading.

Research-record/navigation checks: `client/src/utils/report-record-delete.test.cjs`, `research-workspace-flow.test.cjs` and `workspace-layout.test.cjs` cover cancellation, uncertain retry identity, version isolation/pagination, per-task drafts, same-page selection, mobile history and invariant primary navigation. Backend deletion tests run with disposable `RESEARCH_TEST_DATABASE_URL`/`COUNCIL_TEST_DATABASE_URL`; include source invalidation at strategy execution/channel publication, memory provenance, legacy resurrection and late callback fences. Register49 in both fresh/upgrade parity and narrow fixtures selecting report/session rows. Actual desktop/mobile browser checks use only a fictional database; personal report/task records are never deleted as smoke tests.

Browser collection: install the pinned Chromium via `npx playwright install chromium` before `npm run test:browser`. CI installs browser dependencies and runs nested data-library/browser specs in the complete server suite. The standalone `scripts/check-browser-sandbox.cjs` preflight preserves the real launch failure; only a confirmed AppArmor namespace denial permits an exact-binary userns profile on the GitHub runner. It does not disable Chromium sandbox or change global kernel restrictions. Its synthetic dependency tests run before the probe. Real Chromium renders fictional authenticated content; network proxy tests separately check public-address pinning and request limits. Browser data/tool integration tests require a disposable `RESEARCH_TEST_DATABASE_URL`, no real credentials or paid Agent calls. See `docs/browser-source-implementation.md` for scope and verified evidence.

## Agent telemetry verification

Bundled tooling adds `server/modules/tool-capabilities/*.spec.ts` to the server
suite, using disposable `RESEARCH_TEST_DATABASE_URL` and
`TOOL_CONNECTIONS_TEST_DATABASE_URL`. Include migrations59–60 in fresh/upgrade/
replay fixtures. Candidate discovery, exact catalog CAS, idempotent grants,
revoke/re-enable and final publication fences require database execution.

`npm run test:bundle` includes deployment contracts and sandbox protocol tests;
the actual Docker test requires `SANDBOX_REAL_TESTS=1` and built analytics image.
An intentional real-engine skip is not a successful sandbox acceptance. Run
`node --test workers/sandbox/broker.integration.spec.cjs` with that flag; preserve
unknown-cleanup receipts until exact labeled resources are reconciled. Full
bundle checks also execute the actual twenty-document corpus, Chromium sandbox
and real MCP against a unique Compose project with empty volumes. See
`docs/bundle-packaging-validation.md` and `workers/sandbox/VALIDATION.md` for
measured evidence, remaining gates and platform-specific limits. Never use
personal DB, paid model credentials or portfolio records as these fixtures.

Run `npm run test:telemetry` with `TELEMETRY_TEST_DATABASE_URL` pointing to a disposable PostgreSQL16 database. Include migration52 in fresh/upgrade checks. Test owner/source-deletion isolation, historical revision/cycle grouping, unknown usage, ratios and pagination, feedback upserts, metadata redaction, export failure and no paid retries. UI acceptance uses fictional intercepted APIs at 1440px/390px with real filters, run links and feedback; unknown/empty/failure states must not show Figma sample data. Full lint/Web build, client/server/local-agent, wiring, architecture and context checks still apply. See `docs/agent-telemetry.md`.

Local diagnostic changes additionally require fixture coverage of native preflight/spawn/first-output/exit evidence, Companion schema transport and observer failure isolation. Telemetry integration cases exercise exact run/cycle/revision/task matching, deleted-source/owner fences, partial journals and local parse rejection after successful execution. Client/browser acceptance checks live snapshot refresh, reconnect, task/tool filters, paused follow, unknown silence, retained data on transient failure and allowlisted metadata downloads. Old companions must remain compatible; targeted bridge tests cover modified wire code without enabling installer packaging.

## Team workspace tests

Migration61, Teams persistence and real Council bridge tests use `TEAM_TEST_DATABASE_URL` on a disposable PostgreSQL16 database; register `teams/*.spec.ts` and `shared/team-templates.spec.ts` in test:server and the TEAM variable in CI. Client team tests are in the existing utils glob. Use separate databases for independently running DDL-heavy suites; never personal data. Timestamp-sensitive fixtures must state historical source times explicitly rather than assuming Windows and Docker clocks agree to a millisecond. New-schema/upgrade/repeat checks must retain the partial legacy task-key index and independent workKey uniqueness. Research is gated by TEAM_WORKSPACE_ENABLED and TEAM_RESEARCH_ENABLED, while cleanup/queries and authorization remain active. `test:wiring` resolves Teams providers without calling lifecycle hooks.


## Independent-agent and automatic-team verification

Set `AGENT_ROSTER_TEST_DATABASE_URL`, `TEAM_TEST_DATABASE_URL`, `A2A_TEST_DATABASE_URL` and `TELEMETRY_TEST_DATABASE_URL` to disposable PostgreSQL16 databases. The full server script includes `server/modules/agent-roster/*.spec.ts`, `team-runs/*.spec.ts`, `a2a-agents/*.spec.ts` and all existing Team/Council/telemetry suites. CI explicitly supplies those URLs. New nullable identity fields require migration65, not just the roster/team/A2A tables62–64. Keep `01_schema.sql` generated through `node scripts/db/sync-fresh-schema.cjs`.

Animal identity additionally requires migration66 in the explicit registry and generated fresh schema. Roster integration tests cover deterministic template backfill, invalid IDs, avatar-only edits without capability changes, repeated migration retaining selected avatars and immutable version/receipt contents. `agent-roster.teams.integration.spec.ts` exercises the actual roster→Team→Council snapshot path with a disposable `TEAM_TEST_DATABASE_URL`; ordinary conversation acceptance uses `COUNCIL_TEST_DATABASE_URL`. Fake model transports must complete real persistence and receipt paths without paid calls.

Client checks include `client/src/utils/guided-onboarding.test.cjs`, `guided-team*.test.cjs` and `client/src/features/telemetry/telemetry-identity.test.cjs`. Cover actual sequential API receipt replay after every lost response, pinned version/binding conflicts, expired previews requiring fresh user review, default global/account caps and the explicit startup replacement authorization. Browser checks should use a fictional isolated backend or intercepted fixtures for the full holdings→roster→team journey on desktop/mobile. Such checks do not substitute for five real novice participants; record that usability study separately and do not claim it passed.

UI repair regressions include `agent-animal-identity.test.cjs`, `guided-team-draft.test.cjs`, `guided-team-interaction.test.cjs`, `guided-team-resume.test.cjs`, `import-continuation.test.cjs` and `workspace-navigation-interactions.test.cjs` under `client/src/utils/`, alongside existing navigation/layout/import/research/team suites. Check rendered editing, actual selected participants, owner-isolated drafts, legacy-resource verification, unchanged unknown request payloads, separate investment/holdings roots and valid return/history links. Run actual desktop1440/mobile390 browser journeys separately; source or DOM assertions do not establish visual acceptance. Preserve results and unfinished gates in `docs/ui-regression-repair-validation.md`.
