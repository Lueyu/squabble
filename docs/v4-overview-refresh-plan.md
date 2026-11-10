# V4 overview and reading-flow refinement

**Requested behavior:** saved holdings render promptly; imported holdings immediately produce current account figures and automatically obtain recent historical reference prices; companions can be removed from their list; daily synthesis and historical reading have separate pages.

**Architecture:** retain financial ledgers and actual saved valuation rules. A separate historical-price projection values today's fixed positions against dated closes and dated FX, with provenance and gaps. It is labelled as a current-position reference, never historical ownership or investment return. New market-data cache work runs asynchronously and never calls research models. Account removal archives one account and preserves financial history.

## Work packages

- [x] Holdings performance: independently render saved holdings before slow dashboard/quotes; retain visible rows during refresh or auxiliary failure. Verify with delayed network fixtures and read-only API timing.
- [x] Historical/current marks: new portfolio-history provider/cache/schema; strict dated close/FX rules, owner-scoped position identities, bounded deduplicated fetches and retry backoff. Current account marks include basis and partial coverage. No unknown cash becomes zero.
- [x] Register additive migration 48, export its schema/module and hook completed position/transaction imports to asynchronous prefetch. Existing imports receive the same work when the overview is opened.
- [x] Overview frontend: render current marks in headline, legend and account cards. Prefer reliable saved account observations; automatically fall back to clearly labelled current-position historical references. Preserve missing-price gaps, stable account colors, filters and source-return behavior.
- [x] Companion removal: list action with one confirmation, owner/revision/request protection, archive and stop only the selected account; retain its ledger/reports.
- [x] Reading flow: `/daily` contains the daily content without history; `/analysis` contains only a compact paginated historical list linking exact saved versions. `/research/portfolio` retains explicit current portfolio research. Update route ownership, old links and return behavior.
- [x] Validate provider parsing, history/FX boundaries, partial/current values, cache recovery, owner isolation, archive races, slow-loading UI and compact history reading with fictional fixtures and disposable PostgreSQL. Run required lint/client/server/local-agent/context/architecture/build checks, independent review, then update PR89.
- [x] Prepare a new private production release; back up the current personal DB/config/state, preserve native Agent mode and owner, deploy to the existing3192 entry and verify actual holdings, account amounts and historical chart population without invoking models.

## Success checks

1. A delayed dashboard cannot delay or erase saved holdings.
2. After importing a supported position, account cards have the strongest available truthful current value; historical lookback starts without another manual import or refresh action.
3. Reference points expose dates, price/FX sources and missing coverage; no future close, current FX substitution or false personal return is accepted.
4. Delete from a companion card removes only that account from the active list and preserves its history.
5. Daily overview has no history panel; the history destination is a list, and closing/back from an old report returns to that list.

## Verification record

Client418/418 and server990/990 passed with zero skipped database integrations. The local-agent suite passed180 with one Windows POSIX process-group skip; architecture5/5 and context15/15 passed. Lint, both type checks, CSS, production web build, compiled module wiring and context path validation passed. The final historical-provider/import-hook cases were additionally rerun after the full server process began, using disposable schemas.

A fictional two-position US/HK import returned its committed receipt in135ms, began prefetch automatically, and subsequently exposed31 complete days without reimport. Current marks and fixed-position reference prices retain distinct basis and timestamps. Public-provider smoke tests fetched actual US/HK/CN closes and dated HKD/CNY FX without using personal data or models. These timings are observations, not a latency guarantee.

Independent reviewers found and closed current-null fallback to old NAV, false current dates on saved returns, reference-date timezone drift, source-free synthetic observation labels, recovery from a failed reference request, and synchronous historical scanning cost. Financial history is preserved by account archive. User-visible runtime acceptance is recorded in the PR once the private instance is updated.
