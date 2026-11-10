# Portfolio workspace validation

Reviewed on 2026-11-09 against baseline `9e2d83a` plus the `codex/portfolio-redesign` changes. This records the implementation of the [reviewed design](portfolio-workspace-design.md) and [development plan](portfolio-workspace-plan.md), not a personal production cutover.

## Design and behavior review

The independent design review's eight findings were incorporated in Figma and the implementation. Further independent source reviews covered account ownership, immutable strategy/source fences, multi-account runtime selection, cash allocation, migration replay, comparison validity, navigation and mobile layout. Findings were corrected before the final checks.

The implemented overview uses a large saved-observation chart with separate real/simulation lines, stable account colors, period and amount/return controls, explicit gaps and an accessible historical-values table. Independent accounts each own their combination draft, preview, policy revision, runtime profile and pause state. Reports can seed a selected account's draft; application remains explicit. Channel questions and pending work retain their selected account.

## Automated checks

Local environment: Windows, Node 24.16, PostgreSQL 16 in a disposable loopback cluster. Every integration database used fictional data and was separate from the personal instance.

| Check | Result |
|---|---|
| `npm run lint` | ESLint, Stylelint and both TypeScript checks passed |
| `npm run test:server` | 937 passed; zero failures or skips |
| `npm run test:client` | 373 passed; zero failures or skips |
| `npm run test:local-agents` | 180 passed; one POSIX process-signal case skipped on Windows |
| `npm run test:architecture` | 5 passed |
| `npm run test:wiring` | Compiled application providers resolved without starting background jobs |
| `npm run build:web` | Passed; existing client chunk-size warning remains |
| `npm run test:context` | 15 passed; zero failures or skips |
| `npm run check:context` | Valid, no structural errors; semantic review remains a separate responsibility |
| `git diff --check` | Passed |

The initial full server run exposed stale test setup in Council, migration-upgrade and simulation-review suites. Their fixtures were corrected without weakening product ownership or ledger checks; all 937 tests passed on the final full run. Required Linux CI (Lint & typecheck, Agent tests, Docker image build) is reported on the pull request separately from these local results.

## Browser and preview acceptance

The built application was deployed to an independent local preview using fictional real/simulation ledgers, isolated authentication and no paid model or personal native-agent connections. Automatic trading is disabled in this preview. Browser acceptance covered:

- Desktop 1440px and mobile 390px overview, account lines and comparison controls. Entering from an account preselects it while allowing additional accounts.
- Creating an independently named simulation, opening its detail, and preserving the other accounts.
- Saving a changed combination draft, previewing it, and applying the reviewed revision.
- Pausing one account while a sibling remains running.
- Asking about the selected simulation's cash and receiving that account's balance.
- Reading a realistic long report with desktop/mobile section navigation and no page overflow.
- Opening and keyboard-scrolling the historical valuation table with its caption and column headers.
- Preserving legacy strategy/report deep links.

No personal database was migrated or used for a smoke test. The global installed contributor skill remains unchanged until the reviewed branch is merged; the repository copy and all five architecture flows were updated in this change.
