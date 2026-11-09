# Assistant Maintainability Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent implementation tasks and independent final review. The maintainer authorized autonomous execution of gradual convergence.

**Goal:** Make the current investing-assistant code easier to navigate, modify and explain without changing its behavior.

**Architecture:** Extract shared research infrastructure from retained analysis, give research routing a single Nest owner, and put strategy UI/state in one feature directory. Preserve runtime contracts and enforce the new dependency directions in lint.

**Tech Stack:** Existing React, TypeScript, NestJS, PostgreSQL, Node test runner, ESLint and JSDOM; no new runtime dependencies.

## Task 1: Baseline and isolated workspace

- [x] Create an isolated worktree from `origin/main` and a `codex/` branch.
- [x] Install lockfile dependencies using `npm ci --ignore-scripts` for Web work.
- [x] Run existing strategy editor/management/source tests and research adapter,
      route and model tests before moving their source. Preserve command logs.
- [x] Initialize a new temporary PostgreSQL cluster on an unused loopback port;
      create only fictional test data and record its directory for cleanup.

## Task 2: Strategy feature ownership and readable editor

**Files:** Move the InvestmentStrategy editor, section and source dialog from
`client/src/pages/Today/` to `client/src/features/investment-strategies/`; update
all client imports and client test loaders. Create focused hook/form/review files
inside that feature as indicated by the existing editor's responsibilities.

- [x] Run `node --test client/src/utils/today-strategy-editor.test.cjs client/src/utils/strategy-management.test.cjs client/src/utils/strategy-preparation-flow.test.cjs client/src/utils/investment-strategy-source.test.cjs`.
- [x] Move the components and update literal import and fixture-loader paths;
      do not keep Today re-export shims.
- [x] Extract the editor's saved/content/preparation state and `work` operations
      into a named hook. Preserve the existing lock, request-key refs and effect
      cleanup. Give the action union a named type instead of widening strings.
- [x] Extract form sections and saved execution review presentation into focused
      components with explicit props. Keep bilingual text and accessible labels.
- [x] Format changed production TSX with the repository Prettier settings. Add
      comments at snapshot, receipt and confirmation boundaries.
- [x] Rerun the four focused tests plus simulation journey and report-plan tests,
      then `npm run type:check:client`. Fix any change in behavior before handoff.

## Task 3: Shared research modules

**Files:** `server/modules/multi-agent/` shared model/evidence/context services
and their tests; new `server/modules/research-core/`; new
`server/modules/research-routing/`; consumer imports and Nest module declarations.

- [x] Inventory transitive local helpers before moving each service. Keep legacy
      pipeline/report construction under `multi-agent/` and extract only generic
      error helpers needed by evidence collection.
- [x] Create `ResearchCoreModule` with model/evidence/context providers and their
      source adapters. Import Quote/Fx modules and rely on existing global platform,
      settings and budget contracts; do not create a LocalAgents module cycle.
- [x] Move legacy-only holding-rating mutation to its legacy command owner if
      needed to keep the foundation's responsibility clear, preserving its query.
- [x] Change consumers to import the new files and modules. Remove duplicate
      provider ownership, including the existing Settings LLM registration only
      if the verified DI graph supports its removal without a cycle.
- [x] Move `PortfolioResearchRouteService` and its tests to research-routing;
      declare it once and export it to Experience and PaperTrading.
- [x] Use the explicit module form:

```typescript
@Module({
  imports: [ResearchCoreModule, LocalAgentsModule],
  providers: [PortfolioResearchRouteService],
  exports: [PortfolioResearchRouteService],
})
export class ResearchRoutingModule {}
```

- [x] Move related tests, update test stubs/loaders, and tell the coordinator
      which test globs must be added. No tests disappear from `test:server`.
- [x] Run moved tests and affected Council/Experience/PaperTrading checks; run
      `npm run type:check:server`. Inspect imports for circular initialization.

## Task 4: Import boundaries and documentation

**Files:** `eslint.config.js`, `scripts/module-boundaries.spec.cjs`, `package.json`,
`.github/workflows/ci.yml`, `AGENTS.md`, `docs/README.md`, `docs/development.md`,
`CONTRIBUTING.md`, `docs/code-reading.zh-CN.md`, architecture and contributor skill.

- [x] Add scoped ESLint `no-restricted-imports` rules: strategy features cannot
      import pages; shared cannot import client/server implementation; research
      core cannot import legacy/current orchestration; paper trading cannot import
      Experience. Include equivalent aliases, not just one relative spelling.
- [x] Test rules with ESLint's API using representative file paths and both
      allowed and forbidden imports. Assert the diagnostic rule ID, not source
      text. Run these checks in CI alongside existing context checks.
- [x] Add extracted module test globs to `test:server`; keep required check names.
- [x] Add `scripts/check-module-wiring.cjs` and `test:wiring` to compile and
      resolve the real Nest provider graph with an explicit disposable database.
      Do not call application init/listen/bootstrap; assert shared provider
      ownership and always close the pool and temporary native-task directory.
      Run this in CI after server tests, using its isolated PostgreSQL service.
- [x] Add one short AGENTS router and a Chinese reading tour. Update current
      documentation navigation and mark superseded proposals. Correct migration
      and offline/integration wording using the actual test contracts.
- [x] Update repository map, context manifest and architecture module arrows;
      retain all five behavioral flows and record their reviewed impact.

## Task 5: Verification, review and PR

- [x] Run `npm run lint`, `npm run test:client`, `npm run test:local-agents`,
      `npm run test:context`, `npm run check:context` and `npm run build:web`.
- [x] With all seven required test database variables (plus channel explicitly)
      pointing to the disposable cluster, run `npm run test:server` and
      `npm run test:memory-eval`. Record pass/fail/skip counts from actual output.
- [x] Run boundary checks, local document link validation and `git diff --check`.
- [x] Independent review first checks requirements, then correctness and code
      quality. Fix important findings and repeat only affected checks.
- [ ] Commit reviewed changes, push the branch and create a PR. Watch required
      CI to completion and address failures attributable to this change.
- [ ] Stop the disposable test cluster. Leave the user's running installation
      unchanged. Report PR, code-reading entry, validation and remaining work.

## Local verification record (2026-11-09)

- Baseline: client focused 34/34; research focused 58 passed and 2 database cases skipped before the disposable cluster was prepared.
- Final server suite on PostgreSQL 18.6: 911/911, zero skips; client suite: 352/352, zero skips.
- Fictional memory evaluation: 99/99, zero skips. Native agent suite: 180 passed, one POSIX-only skip on Windows. Development process suite: 8 passed, one POSIX-only skip on Windows.
- Lint, both type checks, Web build, 5 architecture-rule cases, compiled provider wiring, 15 context helper tests, structural context checks and whitespace checks passed.
- Wiring also rejected a missing explicit test database before application creation. The positive check resolved the compiled application without init/listen/bootstrap.
- Independent frontend, backend and delivery reviews reported no actionable findings. Documentation review checked 31 Markdown files, 238 relative links/anchors and 1,009 source/current-document files for 23 moved paths.
- Build retains existing large-chunk and Tailwind module-format warnings. This refactor does not claim a bundle-size improvement or full browser-to-backend acceptance.
- CI uses PostgreSQL 16 and Linux; its result is recorded in the PR. The local database version/platform difference is intentional and is not a substitute for CI.
