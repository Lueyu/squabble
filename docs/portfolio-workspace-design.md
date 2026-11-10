# Portfolio workspace design

The workspace makes real and simulated portfolio value the main visual, with independent simulation accounts and explicit, reviewable strategy changes. This implements the owner's approved Figma direction: clear, attractive, restrained, with useful green, blue and purple accents.

Design: https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=6-182

## Reviewed screens and decisions

- Overview: `6:182`; amount mode: `13:497`; mobile: `13:1182`.
- Account list: `9:101`; detail: `8:62`; editor: `9:398`.
- Research: `10:215`; report: `10:374`; channel: `10:466`.
- Assets: `11:329`; import: `11:494`; settings: `11:606`.
- Missing observations and late account inception: `27:1177`.
- Independent designer review and accepted changes: `27:1421`.

The independent product-design review accepted the restrained visual direction. Its eight changes were adopted: all mobile account entries, explicit metric controls, precise valuation/archive/draft states, a missing-data chart example, compact account-detail chart with account switching, grouped draft/preview actions, separate account and status colors, and realistic long-form report content with readable metadata. Example portfolio numbers in Figma are fictional and must never ship as user data.

## User journeys

1. Open overview without triggering research, select a period and accounts, inspect the large chart, then open a specific account.
2. Create an independently named simulation from a reviewed real-portfolio seed; creation never archives another account.
3. Select several confirmed strategies for an account, set budget caps, save a draft, preview changes, then explicitly apply the reviewed revision.
4. Pause one account without changing other accounts. Pause stops automatic orders including protective orders; valuation observations continue.
5. Read an immutable report, choose a target simulation and save strategy material as a draft. Reading/importing does not activate it.
6. Reach research, channel, real assets, imports and settings through stable navigation. Retain existing legacy routes and data interpretation.

## Data and execution contract

Each account has its own policy revision, combination of immutable confirmed strategy snapshots, execution profile and published mandate. Owner-level strategy drafts remain a library. UI selection is not a global execution switch. Requests identify the account; ambiguous old write requests fail clearly when several accounts exist.

Strategy budget percentages divide the investable allocation after the account cash floor. They are caps and never imply rebalancing. Account risk limits and cash reservation apply to all strategies together. Conflicting overlapping buy/sell directions or incompatible targets block combination application with source attribution. A strategy entry already filled does not execute again merely because a combination was edited or paused/resumed.

Preview/apply uses persisted or reproducible canonical hashes, expected account-policy revision, immutable strategy revisions and source revalidation in the final owner/account transaction. All automatic execution paths retain final authorization checks. New accounts are simulations; this work adds no real broker execution.

Comparison is a read-only aggregation of saved real valuation points and simulation snapshots. Use actual timestamps and USD. Late accounts start at the first trusted observation; missing intervals break the line. Default to equity amount. Percentage views must name their methodology; asset change is not investment return. Return values without a valid starting valuation and sufficient cash-flow coverage remain unavailable with a reason. Initial-only accounts do not show a fabricated zero return.

## Visual and responsive contract

White workspace, pale sage desktop navigation, dark green type, green primary actions. Account identity colors remain stable across legend, curve and cards; status colors are semantic. Desktop overview chart is approximately 420px high and the dominant first-screen content. Phone chart remains about 300px high, controls wrap and all accounts remain reachable. Account detail prioritizes management with a compact chart. Forms have one grouped action area. Reports retain a readable prose column, numbered sources and a narrow contextual navigation area.

Missing/loading/error/empty states are visible and retryable. Inputs have labels; keyboard controls and non-color account identity are required. Existing dark-theme preference remains usable. Bilingual strings accompany behavior changes.

## Verification and delivery

Use fictional data and an isolated disposable database for account isolation, upgrade/restart, conflict, stale-preview and cash contention tests. Browser visual checks use fixtures or a separate isolated instance, never the personal research workspace. Build web only. Record source and documentation changes, passing checks and remaining limitations; retain a reviewable PR and a private preview deployment.
