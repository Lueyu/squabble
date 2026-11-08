# Daily report to simulation user journey

The user explicitly requests a complete, self-explanatory daily report → strategy copy → simulated execution → channel feedback → strategy management loop.

## Chosen behavior

- The report's primary strategy action imports the exact saved execution section once and opens that draft in `/paper?investmentStrategyId=…`. Copying does not start trading or invoke a model. General research additions remain available separately.
- New users first create a simulated account on the same destination page. The requested strategy ID survives setup and opens when the account is ready. The page exposes report, strategy and channel steps with short actionable labels.
- The simulation page owns strategy editing and deletion. Draft deletion preserves technical audit receipts; removing the current strategy stops automatic execution atomically and preserves historical confirmations and trades.
- Changes to periods/limits retain existing interpreted rules and use deterministic preview. Changed text requires renewed interpretation. Status distinguishes configured, waiting, observing, paused and expired.
- A daily report with absent/invalid AI execution output retains an explicitly system-authored observation plan and its error; it cannot invent executable directives, prices or risk limits.
- Actual complete and partial fills appear as visible channel messages from stock friends. Deduplication and authoritative ledger/source checks remain in force. Existing evidence-backed suggestions and fact questions remain available.

## Validation and boundaries

Use fictional data in a disposable PostgreSQL cluster. Cover exact-source import, first-time setup, draft management and stale revisions, runtime stop fences, complete-fill channel delivery and replay. Run client/server/local-agent suites, lint, web build, context checks and browser acceptance. The live installation, paid research, real holdings and broker actions are outside this development task. Update the five architecture flows and affected contributor knowledge before PR delivery.
