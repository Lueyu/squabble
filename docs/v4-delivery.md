# V4 implementation verification — 2026-11-10

This change implements the approved companion workspace in the existing React/NestJS application. It replaces navigation and adds persisted product flows while preserving account ownership, immutable reports, explicit strategy application and real-ledger write boundaries. See [usage](ai-friend-v4.md), [portfolio contracts](v4-portfolio-workspace.md), [daily/memory contracts](v4-daily-and-memory-workspace.md), and [architecture](architecture.md).

## Verification

| Check | Result |
| --- | --- |
| `npm run lint` | Passed: ESLint, server/client types and CSS |
| `npm run test:client` | 406 passed, zero failures/skips |
| `npm run test:server` | 972 passed, zero failures/skips; all integration database variables set to disposable PostgreSQL |
| Final overall/native recovery review | 20 passed, zero skips, including the last recovery changes |
| `npm run test:local-agents` | 180 passed, one POSIX process-group test skipped on Windows |
| `npm run test:architecture` | 5 passed |
| `npm run test:context` | 15 passed |
| `npm run check:context` | Valid paths/metadata; semantic drift reminder retained |
| `npm run build:web` | Passed; existing large-chunk advisory remains |
| Compiled module wiring | Passed; one provider owner, scheduled jobs not bootstrapped |
| Migration upgrade/fresh-schema parity | Passed with additive migrations 46 and 47 |

The final client suite includes recovery copy, daily status localization and interview date formatting. Focused client checks additionally covered 20 interview/workspace cases and nine recovery cases. Server recovery was reviewed after the full-suite process had begun, so its 20-case focused result is separately recorded rather than falsely implying the full suite covered a later source state.

Database tests used a dedicated PostgreSQL 16 container and separate fictional databases/schemas. AI integration responses were stubs. Native task recovery used fixtures; no personal provider session or paid model call was used.

## Browser and design review

Actual Chromium checks covered desktop and 390/320px mobile layouts. A fictional account completed: multi-round clarification → explicit acceptance → saved rule examples → disabled combination draft → budget/enable → preview → application to that account. Help closes into the same conversation; save/reload resumes its state. The large overview preserves metric/range/account filters, and chart/account/back navigation restored both the original URL and 500px scroll position. Direct details retain a parent fallback.

An independent design reviewer checked the running pages. Fixes kept the current question above collapsed history, retained save/return controls at narrow widths and corrected paused-account copy. Daily facts and research layers retain their selected date; Settings integrations and memory/data tabs remain reachable. Final preview uses the production web build with fictional data and automated trading disabled. Only one saved valuation is present, so the graph truthfully shows a single observation instead of invented historical returns.

An independent backend reviewer verified owner, receipt, revision, immutable evidence and budget boundaries. Resolved findings included contradictory order direction, stale saved reviews, exact old-memory lookup, pending/failed order visibility, overall-report classification, interrupted dispatch, independent-barrier continuation and duplicate recovery usage. No unresolved blocking finding remained at handoff.

## Deliberate limits

- Natural-language clarification currently uses conservative local parsing. Unsupported investment logic remains a question or observation; it is not arbitrary autonomous strategy compilation.
- Animal identity is a presentation preference. Selecting an investor philosophy does not silently install its strategy or authorize execution.
- Overall research requires configured research connections and an explicit request. The isolated preview has no model credentials.
- Data center exposes existing provider/import capabilities. Legacy preference memory is visible but its old API does not provide a full edit/version lifecycle.
- This is implementation and an isolated preview, not a switch of the personal running instance. The reviewed branch enters main through the normal PR checks.
