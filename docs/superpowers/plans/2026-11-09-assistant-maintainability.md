# Assistant Maintainability Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent implementation tasks and independent final review. The maintainer authorized autonomous execution of gradual convergence.

**Goal:** Make the current investing-assistant code easier to navigate, modify and explain without changing its behavior.

**Architecture:** Extract shared research infrastructure from retained analysis, give research routing a single Nest owner, and put strategy UI/state in one feature directory. Preserve runtime contracts and enforce the new dependency directions in lint.

**Tech Stack:** Existing React, TypeScript, NestJS, PostgreSQL, Node test runner, ESLint and JSDOM; no new runtime dependencies.

## Task 1: Baseline and isolated workspace

- [ ] Create an isolated worktree from `origin/main` and a `codex/` branch.
- [ ] Install lockfile dependencies using `npm ci --ignore-scripts` for Web work.
- [ ] Run existing strategy editor/management/source tests and research adapter,
      route and model tests before moving their source. Preserve command logs.
- [ ] Initialize a new temporary PostgreSQL cluster on an unused loopback port;
      create only fictional test data and record its directory for cleanup.

## Task 2: Strategy feature ownership and readable editor

**Files:** Move the InvestmentStrategy editor, section and source dialog from
`client/src/pages/Today/` to `client/src/features/investment-strategies/`; update
all client imports and client test loaders. Create focused hook/form/review files
inside that feature as indicated by the existing editor's responsibilities.

- [ ] Run `node --test client/src/utils/today-strategy-editor.test.cjs client/src/utils/strategy-management.test.cjs client/src/utils/strategy-preparation-flow.test.cjs client/src/utils/investment-strategy-source.test.cjs`.
- [ ] Move the components and update literal import and fixture-loader paths;
      do not keep Today re-export shims.
- [ ] Extract the editor's saved/content/preparation state and `work` operations
      into a named hook. Preserve the existing lock, request-key refs and effect
      cleanup. Give the action union a named type instead of widening strings.
- [ ] Extract form sections and saved execution review presentation into focused
      components with explicit props. Keep bilingual text and accessible labels.
- [ ] Format changed production TSX with the repository Prettier settings. Add
      comments at snapshot, receipt and confirmation boundaries.
- [ ] Rerun the four focused tests plus simulation journey and report-plan tests,
      then `npm run type:check:client`. Fix any change in behavior before handoff.

## Task 3: Shared research modules

**Files:** `server/modules/multi-agent/` shared model/evidence/context services
and their tests; new `server/modules/research-core/`; new
`server/modules/research-routing/`; consumer imports and Nest module declarations.

- [ ] Inventory transitive local helpers before moving each service. Keep legacy
      pipeline/report construction under `multi-agent/` and extract only generic
      error helpers needed by evidence collection.
- [ ] Create `ResearchCoreModule` with model/evidence/context providers and their
      source adapters. Import Quote/Fx modules and rely on existing global platform,
      settings and budget contracts; do not create a LocalAgents module cycle.
- [ ] Move legacy-only holding-rating mutation to its legacy command owner if
      needed to keep the foundation's responsibility clear, preserving its query.
- [ ] Change consumers to import the new files and modules. Remove duplicate
      provider ownership, including the existing Settings LLM registration only
      if the verified DI graph supports its removal without a cycle.
- [ ] Move `PortfolioResearchRouteService` and its tests to research-routing;
      declare it once and export it to Experience and PaperTrading.
- [ ] Use the explicit module form:

```typescript
@Module({
  imports: [ResearchCoreModule, LocalAgentsModule],
  providers: [PortfolioResearchRouteService],
  exports: [PortfolioResearchRouteService],
})
export class ResearchRoutingModule {}
```

- [ ] Move related tests, update test stubs/loaders, and tell the coordinator
      which test globs must be added. No tests disappear from `test:server`.
- [ ] Run moved tests and affected Council/Experience/PaperTrading checks; run
      `npm run type:check:server`. Inspect imports for circular initialization.

## Task 4: Import boundaries and documentation

**Files:** `eslint.config.js`, `scripts/module-boundaries.spec.cjs`, `package.json`,
`.github/workflows/ci.yml`, `AGENTS.md`, `docs/README.md`, `docs/development.md`,
`CONTRIBUTING.md`, `docs/code-reading.zh-CN.md`, architecture and contributor skill.

- [ ] Add scoped ESLint `no-restricted-imports` rules: strategy features cannot
      import pages; shared cannot import client/server implementation; research
      core cannot import legacy/current orchestration; paper trading cannot import
      Experience. Include equivalent aliases, not just one relative spelling.
- [ ] Test rules with ESLint's API using representative file paths and both
      allowed and forbidden imports. Assert the diagnostic rule ID, not source
      text. Run these checks in CI alongside existing context checks.
- [ ] Add extracted module test globs to `test:server`; keep required check names.
- [ ] Add one short AGENTS router and a Chinese reading tour. Update current
      documentation navigation and mark superseded proposals. Correct migration
      and offline/integration wording using the actual test contracts.
- [ ] Update repository map, context manifest and architecture module arrows;
      retain all five behavioral flows and record their reviewed impact.

## Task 5: Verification, review and PR

- [ ] Run `npm run lint`, `npm run test:client`, `npm run test:local-agents`,
      `npm run test:context`, `npm run check:context` and `npm run build:web`.
- [ ] With all seven required test database variables (plus channel explicitly)
      pointing to the disposable cluster, run `npm run test:server` and
      `npm run test:memory-eval`. Record pass/fail/skip counts from actual output.
- [ ] Run boundary checks, local document link validation and `git diff --check`.
- [ ] Independent review first checks requirements, then correctness and code
      quality. Fix important findings and repeat only affected checks.
- [ ] Commit reviewed changes, push the branch and create a PR. Watch required
      CI to completion and address failures attributable to this change.
- [ ] Stop the disposable test cluster. Leave the user's running installation
      unchanged. Report PR, code-reading entry, validation and remaining work.
