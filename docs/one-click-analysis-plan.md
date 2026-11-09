# One-click analysis and market overview

> **Historical plan, superseded as the default product guide.** This document
> records an earlier analysis/dashboard design. Retained analysis APIs and
> readers still exist; current Web development starts with the
> [assets, reports and strategy guide](assets-reports-strategy.md),
> [channel guide](channel-workbench.md) and [code tour](code-reading.zh-CN.md).

## Accepted behavior

- No API key: free built-in, deterministic evidence and risk review, visibly labeled Basic analysis. No fabricated AI debate or price targets.
- A configured model key: use the existing multi-agent LLM workflow. Provider failures are reported, never silently disguised as successful basic analysis.
- Default financial data: public, keyless quotes; Finnhub remains optional enrichment.
- Run analysis directly from Daily Analysis for the portfolio or a chosen ticker. Persist the language selected at submission and show progress, failures, and a link to the saved report.
- Reports show a public analysis trail: sources, timestamps, completed/skipped steps, concise arguments, and risk checks. Do not request or store hidden model reasoning.
- Dashboard: market index changes and a clearly labeled estimated market mood derived from available index returns, with source dates, coverage, stale/error states, and an explanation of the formula.

## Implementation work

1. Extend shared settings/run/report/market contracts; migrate run language and report trace with defaults for existing rows.
2. Implement settings defaults and guidance, preserving credential encryption and SSRF restrictions.
3. Connect language-aware basic/LLM analysis to real report persistence, and add meaningful tests for no-key, failure, locale, and report behavior.
4. Replace external-agent instruction dialogs with a direct runner, progress polling, and report trace UI.
5. Add authenticated cached market data endpoint and theme-aware bilingual market card below Dashboard AI status.
6. Verify backend/client tests, lint/types/styles, desktop/mobile browser flows and production Docker build; review and sync to GitHub.

## Verification boundaries

Use demo or isolated test data for live checks, mocked LLM responses for paid-provider tests, and real keyless quote smoke checks. No broker orders, credential disclosure, model installation, or paid API calls are needed.
