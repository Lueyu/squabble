# Current asset marks and historical reference prices

The overview can immediately show the value supported by imported holdings and known cash. It does not require a saved NAV observation or a trusted simulation seed to show a present amount. A separate historical reference uses **current quantities × dated closing prices × dated FX**. It excludes cash, transactions and dividends and is not a reconstruction of the owner's past holdings or investment return.

## Current amounts

`PortfolioComparisonSeries.currentMark` is additive to the existing comparison contract. `equityUsd`, saved points and `returnPct` retain their original verified-observation rules. `PortfolioCurrentMarksService` reads the owned current holdings, cash and shared public cache; it does not create a NAV point.

- `total_assets`: every nonzero holding and the required cash scope can be valued.
- `holdings_market_value`: all holdings can be valued but cash is not fully reconciled; the displayed value excludes cash.
- `known_assets`: some positions or cash remain unknown; the displayed value is only the known portion.

`complete` describes valuation coverage, not verification of a live market quote. A saved/imported price without an observation timestamp is an immediate fallback and keeps `asOf: null` plus `SAVED_PRICE_TIME_UNKNOWN`. A cached close dated within the preceding seven calendar days takes priority once available; its `asOf` is a date, not a fabricated intraday timestamp. `readAt` records the actual projection read time. A legacy USD simulation has a single USD cash ledger even when its holdings trade in another currency. Native-currency simulations retain per-currency cash availability checks. Acquisition cost is never a substitute for a quote.

## Historical reference contract

`GET /api/portfolio-history?period=1M&accountIds=real,<account-id>` requires login. Owner scope comes exclusively from the authenticated request. The same period names as comparison are supported: `1D`, `1W`, `1M`, `3M`, `YTD`, `ALL`; `ALL` is explicitly capped at the most recent 365 days. The default is `1M`. Unknown or foreign accounts fail before scheduling work.

Each point retains `priceAsOf` and `fxAsOf` dates and source names, covered/total position counts, a complete `valueUsd` or null, a separate known subtotal, and gaps. `basis` is always `current_positions_historical_prices`, `includesCash` is false, and there is no reference `returnPct`. `holdingsAsOf` is the time current quantities were read; it does not imply those quantities existed on a historical date.

Dates use the provider's market calendar date for US, HK or CN prices. A current-day unfinished bar is excluded. Only a price or FX observation dated on or before the point can contribute, with at most seven calendar days of prior-observation carry. Carry remains visible through the original source date and `PRIOR_CLOSE`/`PRIOR_FX`; no future price or today's FX backfills an earlier date. Missing coverage stays null. Cash-only accounts do not receive a fictional holdings-price line.

The primary provider is Tencent's public `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` endpoint with `param=<native>,day,,,380,`. The empty final adjustment requests `day`; the parser takes the close column at index 2, validates dated positive observations and the quote identity in `qt`, and rejects `qfqday`/`hfqday` as substitutes. US exchange suffixes are resolved from the provider's validated quote identity rather than guessed. HK and CN identities are canonicalized explicitly. Source provenance is `tencent:unadjusted-close`.

Yahoo's existing chart provider remains a fallback; both `meta.symbol` and currency must match. It reads `quote.close`, never dividend-adjusted `adjclose`, and labels observations `yahoo:split-adjusted-close`. Yahoo documents the difference between [historical prices and adjusted close](https://help.yahoo.com/kb/finance/historical-prices-adjusted-close-sln2311.html). Switching source/adjustment convention breaks the line instead of joining incompatible observations. A greater-than-25% adjacent close change also creates `PRICE_DISCONTINUITY_UNVERIFIED` and a null separator; prices themselves are never altered. This is a conservative discontinuity check, not a complete corporate-action detector. Splits, dividends and other corporate-action holdings/cash history are not reconstructed.

Historical FX uses the dated USD-base time-series response from [Frankfurter v1](https://frankfurter.dev/v1/), inverting its USD/HKD and USD/CNY rates. Response base, actual rate date, finite positivity and requested date range are validated. The existing `FxService.convert(date)` is deliberately not used because it can fall back to the latest rate. The public provider [documents caching daily observations](https://frankfurter.dev/) and offers these reference rates without a model or API-key requirement.

## Background completion and persistence

`PortfolioHistoryModule` contains holdings projection, provider adapters, cache, current-mark projection and the controller. The additive `48_portfolio_history.sql` introduces three public-data tables: `portfolio_history_prices`, `portfolio_history_fx`, and `portfolio_history_fetches`. They hold symbols, dates, prices/rates, provenance and fetch receipts, never owner holdings or account identifiers.

Reads return cached data immediately and enqueue missing/stale public resources. The import hook calls `PortfolioHistoryService.prefetch(owner)` after the holdings transaction. Existing imported users use the same read-triggered path, requiring no reimport. Every fetch covers a fixed 373-day window so a first `1W` request cannot leave later `ALL` reads trapped behind a successful short-range receipt.

Within a process, identical resources share an in-flight promise and at most four provider resources run concurrently. Persisted resource leases deduplicate multiple processes; a random lease token prevents an expired worker's late result from overwriting a replacement worker. Success is reused for six hours; failure retains old observations and a visible failure gap with a five-minute retry delay. A page read during provider failure does not invent points or continuously retry the network. No AI is called, and no holdings, cash, trades, strategies or saved NAV rows are changed by this module.

Price rows are indexed in memory by canonical symbol/currency and date before building the reference series. Per-point lookup is binary search. A reviewer benchmark with 40 fictional positions and 14,920 price rows reduced a 365-day projection from about 1.25 seconds to about 10 milliseconds after warm-up; this is a local measurement rather than a service-level guarantee.

## Retained intraday reference facts (migration67)

The independent five-minute valuation sampler retains verified `marketQuotes` on owned real and paper observations, including a useful subset when full NAV remains unknown. `PortfolioIntradayReferenceService` reads only the authenticated owner's selected accounts and deduplicates quote facts in PostgreSQL. It requests no quote and writes no NAV. Current quantities, rather than the quantities or recorded totals of the historical account observation, determine this reference.

Day/week views keep actual five-minute quote representatives; month views keep actual hourly representatives, including coverage and convention boundaries. Longer periods retain daily closes. `timestamp` exists only for a real provider observation, and `priceAsOf[].timestamp` preserves its exact source time. Repeated captures of an unchanged quote do not create new market points. Daily rows keep date-only source semantics. A differing unverified close/quote convention creates a boundary rather than silently joining different price bases.

For intraday non-USD conversion, daily FX rows have no trusted publication time, so only earlier calendar dates may contribute, within the existing seven-day bound. Same-day or future daily FX cannot leak into a morning quote. Prior FX and source dates remain visible. A partial line still requires a stable covered ticker set; it never becomes complete NAV or an investment return. Old price history is not backfilled with fabricated intraday observations.

The sampling-only US Tencent source validates the requested quote identity, quote date and last minute evidence, and explicit `pandata.season` EST/EDT against an `America/New_York` round trip and verified regular sessions. Ordinary quote/order selection is unchanged. Missing or contradictory time metadata remains unavailable; the retrieval clock is never used as market time. A public MSFT probe on2026-11-13 verified this path without a database or personal account; Yahoo's two endpoints returned403 on the same host. This is availability evidence at that time, not a guarantee. Existing calendar verification currently covers2026; later years remain unavailable until their calendars are verified.

Reference-only visual warning connectors may span a price-discontinuity or
convention gap. They use a distinct warning style, connect only actual endpoints,
and have no synthetic tooltip value or account-selection authority. The underlying
point remains null and its exact risk remains visible. Actual NAV/return financial
boundaries keep their original separation; a visual connector never authorizes a
return or reconstructs split/dividend history.

## Verification

The targeted command is:

```powershell
# Both variables must point to a verified disposable database.
npx tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/portfolio-history/*.spec.ts server/modules/paper-trading/portfolio-comparison.integration.spec.ts server/modules/paper-trading/portfolio-comparison.rules.spec.ts
```

It passed **23/23, zero skipped** on 2026-11-10. The initial history suites alone contained **13 passing tests**, independently rerun by the reviewer. After the import hooks were registered, one end-to-end import scenario was added and the updated integration file passed **8/8** (the history suites now contain 14 tests). It constructs the real `ImportService`, commits a fictional CSV position, observes the commit hook start a deliberately blocked provider before any history GET, verifies the import response already returned, then releases the provider and reads the automatically completed reference/current mark. Replaying the import receipt and history reads does not duplicate the provider request. Tests create/drop random fictional schemas using `HISTORY_TEST_DATABASE_URL` and `STRATEGY_TEST_DATABASE_URL`; all provider responses in integration tests are stubs. Other coverage includes unknown cash with immediate holdings value, unchanged actual NAV/return, owner isolation, legacy USD cash scope, current dated closes outranking undated imports, HK/CN historical FX, rejection of future FX, quick reads, cross-process deduplication, restart persistence, failure backoff, expired-lease takeover and late-write fencing, four-resource concurrency, provider identity validation, missing/current-day bars, and discontinuity gaps.

Separately, the actual provider class made read-only public network checks without a database: MSFT returned 21 completed daily observations in 310 ms, 0700.HK returned 20 in 135 ms, and 600519.SH returned 21 in 131 ms, spanning 2026-10-12 through 2026-11-09. All used Tencent unadjusted close. Frankfurter returned 42 dated currency observations for HKD/CNY over that window. These checks demonstrate provider availability at that time, not a guarantee of future uptime. No user data, production service or paid model was used.

Architecture impact: current comparison remains the saved-observation authority; the new module supplies separate present marks and reference prices. The root module registers the additive provider/controller and import hooks. The main architecture diagrams and migration registry are maintained by the root task.

## Partial reference display

If no complete reference point exists because an instrument is unresolved, the frontend can display a clearly labelled partial reference. It anchors to the last point's nonempty, nonduplicate covered ticker set, and plots only points with exactly that set, the same covered/total counts, finite nonnegative known value and an allowed missing/prior-observation gap. Changed coverage, missing FX that changes the set, provider-convention changes, price discontinuities and unknown risk gaps remain breaks. The whole line stays partial; it never switches between partial and full-portfolio values. Missing symbols come from the last point, not the historical union. Coverage such as12/13 counts positions, not asset value. Backend full valueUsd and actual NAV/return/current marks retain their original nulls and coverage.
