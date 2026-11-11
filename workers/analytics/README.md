# Reproducible analytics worker

This is a separate file-based Python worker. The Nest application never executes
model-authored Python on its host. Production execution uses a configured E2B
template with outbound internet and public sandbox URLs disabled. The local
commands below execute only repository-owned fictional fixtures.

## Local offline verification

Install Python **3.12.10** and uv **0.13.1**, then run from the repository root:

```powershell
uv sync --project workers/analytics --frozen
uv run --project workers/analytics python -m pytest workers/analytics/tests -q
```

The `python -m pytest` form also works on Windows systems that block the generated
`pytest.exe` launcher. The pinned Backtrader release emits upstream
`datetime.utcnow()` deprecation warnings on Python 3.12; the tests do not modify
or suppress these warnings. No test requires E2B credentials or a model API key.

## Production E2B template

Build a dedicated immutable E2B template containing this directory, its `LICENSE`
and `NOTICE.md`, Python 3.12.10 and `uv sync --frozen --no-dev` dependencies. Make
`squabble_analytics` importable by the template's Python code interpreter. Keep
the full corresponding worker source, lockfile and upstream license files in
the template distribution. Do not install packages during a research run.

Configure the application server, not a model/tool parameter:

```text
E2B_API_KEY=<operator-managed E2B credential>
E2B_ANALYTICS_TEMPLATE_ID=<reviewed immutable template ID>
E2B_ANALYTICS_TEMPLATE_VERSION=<recorded immutable build/version>
SETTINGS_ENCRYPTION_KEY=<existing application private encryption key>
COMPUTE_CLEANUP_WORKER_ENABLED=true
```

All three E2B values are required. Without them `/api/research-compute/configuration`
reports `unconfigured` and execution creates no sandbox. These environment values
are never copied into the sandbox environment or input manifest. A production
template must not contain model, database, browser, application or trading
credentials of its own.

The adapter creates one sandbox per committed job, with its durable UUID as the
provider idempotency key, `allowInternetAccess: false`, `allowPublicTraffic: false`
and IPv4/IPv6 outbound deny rules. It uploads server-read complete dataset files,
the manifest and code marker, calls the worker, streams bounded outputs, verifies
length/hash/type, and attempts `kill()` in `finally`. The template validates its
actual Python/package versions against the manifest before computation. Charts
use the bundled DejaVu Sans font and English labels; CJK font support is not
claimed.

Cloud egress is permitted for public inputs whose source licenses allow research.
Any inherited `portfolio`, `private_material` or `application` classification also
requires the current source policy to allow `egress:e2b`. The model cannot grant
this permission. Classifications are unioned, uses intersected and retention is
the earliest source deadline; inputs and outputs retain source-version links.

Maximum runtime is 120 seconds, total input 32 MiB, output 16 MiB, ten new jobs
per owner per day and one outstanding sandbox reservation per owner. These are
resource limits. They do **not** establish a monetary hard cap: provider billable
quantity and fees remain unknown until supported by provider billing facts.
The catalog's tool deadline also covers creation, upload, verification, download
and artifact persistence. The default worker execution limit is 60 seconds;
requesting the 120-second maximum leaves no guaranteed overhead margin under a
120-second end-to-end tool deadline. Reaching that boundary cancels publication
and retains unknown provider/resource accounting until confirmed, without an
automatic paid rerun. Configure a longer reviewed end-to-end deadline or keep a
smaller execution limit when those phases need more time.

An unknown create/execute/cleanup receipt is not replayed. Repeating the same
request key returns the same durable job. An unknown creation without a sandbox
ID retains its resource reservation; inspect the provider account rather than
creating a replacement automatically. The explicit cleanup endpoint kills a
known retained sandbox and records only confirmed termination, never invented
zero cost. Migration 57 installs source-tombstone and physical-version-delete
triggers that erase linked encrypted job inputs/results and retain cancellation
and sandbox receipts. The optional cleanup worker first runs after 60 seconds;
each bounded tick purges expired inputs and attempts to destroy known cancelled
sandboxes. Unconfirmed destruction remains unconfirmed. It never creates a
sandbox. The explicit `ComputeJobsService.revokeSource`/`purgeExpired` methods
support lifecycle coordination without importing the compute module into source
storage. Status/download revalidate
sources and licenses; they never schedule computation.

## Input/output protocol

The server generates manifest v1 with exact dataset IDs, immutable content hashes,
file-byte hashes, full row counts, source references, inherited policies,
template/code hash, parameters, seed, dependency versions and resource limits.
The worker checks every uploaded file and never reconstructs a series from a
summary or sample. Output `outputs/outputs.json` lists bounded JSON/CSV/PNG/TXT
files with byte lengths and SHA-256. Report links are returned only after every
artifact and its manifest/code record have been saved through the private
artifact service.

Statistics template `returns-v1` requires explicit return/benchmark columns,
frequency, annualization factor and annual risk-free rate. Missing observations
remain missing, coverage becomes partial, and no zero returns are manufactured.
The displayed positive-period ratio is positive observed return periods divided
by observed return periods, not a trade win rate.

Free code is always `exploratory`; successful exit or forged result content cannot
promote it to a validated result. The authoritative classification is set by the
server from the immutable requested mode.

### Daily-history prices are not returns

Real financial history datasets normally contain price levels. Use the fixed
`prices-to-returns-v1` path rather than passing `close` as `returnColumn`:

```json
{
  "datasetVersionIds": ["<daily-history-dataset-id>"],
  "parameters": {
    "inputKind": "prices",
    "dateColumn": "trade_date",
    "priceColumn": "close",
    "returnBasis": "unadjusted-price-only",
    "calendarDatasetVersionId": null,
    "frequency": "daily",
    "annualizationFactor": 252,
    "riskFreeRate": 0
  },
  "seed": 7,
  "maxRuntimeMs": 60000
}
```

This is the runtime `run_statistics` argument shape; ownership, expected hashes
and request identity are injected by the server. For AKTools history use
`dateColumn: "日期"`, `priceColumn: "收盘"`. The worker sorts complete versioned
rows, rejects duplicate dates, and computes adjacent price ratios. It never
treats close levels as returns. Server validation rejects a financial-row
dataset sent through the raw-return template.

For a complete Tushare calendar, include that dataset ID in `datasetVersionIds`
and set `calendarDatasetVersionId` to it. Defaults are `calendarDateColumn:
"cal_date"` and `calendarOpenColumn: "is_open"`; only explicit open sessions are
used. Missing session prices remain missing, and returns across missing prices
are not bridged. Without a calendar the result retains observed endpoint price
change, but annualized return/volatility and Sharpe/Sortino stay unknown because
the number of daily trading intervals has not been established.

`unadjusted` history requires `unadjusted-price-only` and explicitly excludes
cash dividends and split adjustment. `forward`/`backward` history requires
`provider-adjusted-price`, which is not labeled verified total return. Only a
dataset explicitly marked `total_return` accepts `total-return-index`. Unknown
or mismatched adjustment basis fails. A total-return series never receives
dividends a second time.

Currency and unit evidence is read from each row's `_provenance` (or explicit
currency/unit columns). Unknown values remain unknown and are disclosed;
inconsistent known currencies/units fail. Nonzero risk-free rates require a
known consistent currency. No exchange-code guess upgrades missing provider
currency or unit evidence. The output is a dimensionless observed price return,
not investment NAV or a trade fill.

## Fixed historical backtests

Validated mechanics are restricted to the reviewed single-instrument
`fixed-shares-v1` and `moving-average-v1` templates. They use actual Backtrader
1.9.78.123 with `preload=False`, `runonce=False`, cheat-on-close/open disabled and
next tradable-session fills. Models provide version references and strategy
parameters; calendars, market rules, corporate actions, FX, benchmark and universe
records come from complete frozen datasets, not model-provided arrays.

Calendar files contain `{type:"coverage",year,complete:true}` records and
`{type:"session",date,closeAt}` records with exact historical decision instants.
Missing years or sessions fail. Price rows require unadjusted OHLCV,
`instrumentId`, `date`, `availableAt`, currency, halt and limit-up/down status.
Adjusted prices are rejected for order execution. Market-rule files explicitly
state effective dates, lot size, settlement sessions, commissions, minimum fee,
sell/dividend tax, fee currency, odd-lot liquidation permission and slippage.
Minimum fees are converted at the actual session FX. Missing FX or company-action coverage fails.
Only splits and cash dividends are currently supported; other company actions
are rejected. Backtest windows crossing a delisting without supported settlement
accounting are explicitly refused. Unfilled orders crossing a split are explicitly cancelled.

The runner audits trades, blocked orders, company actions, external cash flows,
hypothetical NAV and observed-period statistics. `availableAt` gates strategy
information; report periods and later revisions never substitute for it.
External cash flows are excluded from period investment returns. No production
or simulated orders/fills are written. `current-universe` inputs retain an
explicit survivorship coverage warning. Historical-input completeness and
out-of-sample boundaries are recorded assumptions, not a claim that a strategy
will predict future returns or that every exchange/company action is supported.

The offline golden fixtures cover next-session price, announcement availability,
split/dividend accounting, halt/limit blocks, T+1/board lots, fees, date-specific
FX, deposits, missing-year calendars and current-universe disclosure. Real E2B
network enforcement, billing and cleanup remain separate provider acceptance
work and have not been represented by the fake adapter tests.

## Source formats and current acquisition boundaries

All files below must be owner-scoped immutable dataset versions with exact source
references and complete relevant coverage. Supplying a table in a model prompt
does not create such a version.

| Dataset role | Complete row format consumed by the worker |
| --- | --- |
| Tushare prices for statistics | Raw `trade_date`, `close`, `_provenance`; decimal strings retained. |
| AKTools prices for statistics | Raw `日期`, `收盘`, `_provenance`; explicit selected column names. |
| Tushare statistics calendar | `cal_date`, `is_open`, full requested calendar-day coverage. |
| Execution prices for fixed backtests | `instrumentId`, ISO `date`, timezone-qualified `availableAt`, unadjusted `open/high/low/close/volume`, `currency`, boolean `halted/limitUp/limitDown`. Raw provider price history alone lacks several of these execution facts and is insufficient. |
| Backtest calendar | Year coverage records plus session `date/closeAt`; historical dates and exact close instants, not a current-year calendar extrapolation. |
| FX | `date`, `from`, `to`, positive decimal-string `rate`; exactly one matching direct rate for every needed date/currency. No forward-fill or invented USD rate. |
| Universe | `instrumentId`, `listedAt`, nullable `delistedAt`; metadata `schema.universeCoverage` is `historical` or `current`. |
| Market rules | Versioned effective interval, lot/settlement rules, commission/minimum, sell/dividend tax, slippage, fee currency and odd-lot liquidation flag. |
| Company actions | ISO `date`, `type: split` with positive `ratio`, or `type: dividend` with per-share `amount/currency`. Other action types need another reviewed adapter. |
| Cash flows | ISO `date`, decimal-string `amount`, `currency`, `timing: before_open`; reference through explicit nullable `cashFlowDatasetVersionId`. |
| Benchmark | ISO session `date` and a declared decimal return column, complete matching session coverage. |

The currently connected financial acquisition routes provide AKTools/Tushare
history/calendar/financial records. This worker does **not** add live FX, US SEC,
historical-universe, company-action or market-rule acquisition endpoints. Those
inputs must come from a separately supported versioned source; absent inputs
block a validated backtest rather than being fabricated. A US SEC/fundamental
dataset must preserve period, actual available-at, value, currency, unit, scale,
accounting/consolidation/period/value basis and source hash. Fundamental values
are not price returns. They may be examined by explicitly exploratory code;
the fixed statistical template does not turn EPS/revenue into an investment
return series, and a date-only announcement does not become a precise timestamp.
