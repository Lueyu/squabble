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
| Startup or process management | `npm run test:dev`; inspect Windows/POSIX ownership semantics |
| Schema/migration/package changes | Fresh-schema and existing-schema upgrade checks; affected database suites and `server/modules/experience/migration-packaging.spec.ts`; `npm run build:web` or Docker build as relevant |
| Skill or context helpers | `npm run test:context`, `npm run check:context`; frontmatter, links and scenario verification |
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
database so both suites execute. It is not an eighth CI assignment.

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
explicit list is the startup upgrade authority, currently ending with
`44_strategy_draft_deletion.sql`; numbering is not contiguous. Do not invent a
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
