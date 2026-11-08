# Research → discussion → strategy → simulation

> **Retained advanced workflow.** This guide describes report adoption,
> revisions and experiment/mandate controls that remain available in retained
> flows. For the current daily Web journey, start with
> [assets, reports and strategies](assets-reports-strategy.md) and
> [the channel](channel-workbench.md). Existing APIs and historical readers
> have not been retired by the code organization changes.

The workflow links the existing `/analysis`, `/council` and `/paper` screens. It starts from a current portfolio and evaluates future paper decisions. It does not place broker orders or implement historical point-in-time backtesting. The detailed Chinese user guide is [research-strategy-loop.zh-CN.md](./research-strategy-loop.zh-CN.md).

## Workflow

1. Choose a daily portfolio, stock or period-review report. The library filters topics, dates, adopted/draft/used states and historical versions.
2. Discuss an exact report version or section. Sessions support portfolio, stock, period-strategy and immutable-candidate pre-trade scenes, multiple references and frozen branches. Long conversations can continue using an editable handoff summary with searchable original context.
3. Use a stage summary to create an editable report revision, inspect section changes, save a new immutable version and separately adopt it. Concurrent revisions cannot silently overwrite one another.
4. Preview real holdings and currency cash, then create an independent simulation seed. Opening shares and cash carry forward without fake purchases or double debits. Source changes require a refreshed preview; request retries remain idempotent.
5. Draft a day/month/custom strategy for the selected experiment and team. Review measurable rules, quote bands, stops, exact evidence, business timezone and risk budgets before publishing and starting monitoring.
6. Inspect each candidate's route, report/section references, discussion, quote time, expiry and final outcome. Automatic daily/monthly reviews and custom interval reviews return to the report library and research room.

## Authority and execution

Report generation, adoption and strategy usage have separate pointers. Ordinary updates suggest review; revoked or unavailable evidence freezes dependent risk increases and creates one research-only review thread per rule. Transitive references are checked, so a new summary cannot launder invalid evidence into executable authority.

A mandate binds the account, team version, source versions, dates, universe, directions and limits. Fixed rules are the default. Optional bounded daily AI may narrow price bands, lower exposure, raise stops or suspend rules. It cannot expand authority. Paid work has durable claims; ambiguous/failed same-day work is not replayed. New trading days have distinct requests.

Historical strategy links are read-only and retain their original account identity without switching the selected experiment. Team changes require an explicit version-checked draft rebind and publication review.

Execution priority is: deterministic hard validity → authorized protective exits → high risk/conflicts/events/liquidity Council review → complete low-risk rules directly → limited semantic AI review. Every route ends in the same fresh-data, account-locked execution checks. Slow approvals never authorize changed candidates or superseded versions. Protective monitoring remains independent of slow deliberation.

Candidate cash/share reservations, other pending orders and rolling increases prevent oversubscription and split-order evasion. Account selection, expiry, rejection and replacement release unused reservations. Reductions are exempt from buy-only exposure limits; ordinary sales still respect the published turnover budget. Protective exits remain independent of that budget, with their own price, tradability and sellability checks.

## Simulation assumptions

Native currency cash is preserved, including frozen/unsettled restrictions. FX conversion is explicit. Original cost is reference metadata; strategy return starts at the marked opening NAV. Buy-and-hold and optional SPY/QQQ price-index comparisons share the seed and dates. Price-index returns exclude dividends.

Reading a seeded experiment compares the current source holdings and cash with its opening ledger and shows a change notice without updating the experiment. Quote refreshes and restriction confirmations do not count as source changes; unavailable historical identity remains unknown.

Experiments seeded from real holdings default to 5 bps fees and 10 bps slippage, configurable before creation and frozen with the experiment. Legacy accounts and new cash-only experiments using the existing cash-account flow retain zero fees and slippage; the UI displays each account's actual settings. Market-price simulated fills validate calendars, sessions, quote age, halts, board lots, sellability and settlement. Public quotes may be delayed; data does not provide a complete real-time exchange halt feed.

Missing quote/FX/baseline data produces unknown metrics. Unsupported corporate actions pause execution and invalidate affected performance intervals until a reconciled new seed is created. Limit/partial-fill matching, HK odd-lot matching, shorts, margin and complex derivatives are outside this release. Unknown HK board lots fail closed.

Review intervals follow the mandate business timezone, retained after pause/expiry. Observed maximum drawdown uses only valid recorded NAV points and reports sample coverage; it is not a complete intraday or offline-period drawdown. Per-version contribution reports actual fills and fees, with returns only when exact valuation endpoints exist.

Heartbeat gaps are persisted. Recovery expires stale candidates and evaluates current opportunities without fabricated offline fills. Reviews distinguish losses requiring thesis review from execution constraints and missing information; a loss alone is not classified as a disproven thesis.

## Maintenance

Web-only implementation. Additive migrations `26`–`30` are registered in startup, Docker and CI. SQL files execute intact, including PL/pgSQL triggers. Fresh `01_schema.sql` is synchronized using `node scripts/db/sync-fresh-schema.cjs`.

Historical imports only preserve surviving source records. Missing original timestamps and overwritten reports cannot be reconstructed from current holdings. All records and source resolution are owner-scoped. See shared interfaces for API contracts and [mcp-paper-accounts.md](./mcp-paper-accounts.md) for account-bound MCP usage.

See [validation evidence](./research-strategy-loop-validation.md) for acceptance coverage, test results and release limitations.
