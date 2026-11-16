# Settings navigation redesign — 2026-11-03

## Goal and design

Replace the growing settings feed with a persistent secondary navigation, inspired by the supplied Clowder screenshot and using Squabble's existing theme tokens.

- Research: model connections and default API, local agents, market data, usage/budget, strategy rules.
- Personal/system: appearance, account security, updates.
- Help: configuration guide.

The desktop main navigation becomes an accessible icon rail only while settings is open. The secondary sidebar stays visible while the right content area scrolls. On mobile, retain the existing application drawer and use a labelled category selector. Every section has a `/settings/<section>` URL; `/settings` opens models. Existing budget and local-agent hash links resolve to their new section. Back/forward and reload work.

Mount a section on its first visit and retain it while the user remains in settings, preserving unsaved form drafts across category navigation. Normalize old URLs without replacing the mounted shell. Dialogs and dropdowns belonging to inactive sections must close their portals while retaining editor state for the return visit. Do not persist drafts or secrets in browser storage. Existing save/test/delete APIs, validation, confirmation dialogs and theme preferences remain in use. Give the updates page explicit loading, retry and unavailable states instead of a blank page.

## Implementation plan

1. Add a small navigation definition/resolver with regression tests for default routes, legacy hashes, valid section paths and unknown paths.
2. Extract the existing API settings into `IntegrationSettingsPanel.tsx`, separating model and financial views without changing their mutations. Build `SettingsPage.tsx` around the shared navigation and retained section panels.
3. Route `settings/*` through the new shell; move strategy rules into its menu, update internal shortcuts and retain compatibility redirects.
4. Add scoped responsive settings styles and the settings-only primary navigation rail. Reuse appearance controls inline; supply bilingual navigation copy and explicit update states.
5. Run client tests, TypeScript, focused ESLint/stylelint and a production build. Verify desktop/mobile views, deep links, browser history, retained drafts, themes and account/API actions against an isolated local backend in Playwright.

## Review checklist

- Each existing setting is reachable in one category; no configuration/data migrations.
- Active links use `aria-current`; icons have accessible names; focus is visible.
- Narrow layouts have no page-level horizontal overflow.
- Navigating between sections does not submit or discard unsaved inputs.
- Unavailable update support displays an explanation and existing version when available.

## Verification completed

- `npm run type:check:client`: passed.
- `npm run test:client`: 78 tests passed, including legacy routes, retained panels during URL normalization and inactive model-dialog draft preservation.
- Focused ESLint for changed UI modules and Stylelint for `settings.css`: passed.
- `npm run build:web`: passed; final client changes rebuilt with `npm run build:client`. Existing bundle-size/module-format warnings remain.
- Playwright against an isolated local Squabble backend and database: all nine categories, history navigation, direct/legacy links, reload, four themes in both display modes, English navigation and the mobile primary drawer.
- 36 category/viewport combinations at 360, 390, 768 and 1024px: no horizontal overflow. Desktop appearance also inspected at 1440px.
- Real model/data save and removal requests succeeded using disposable test keys. Provider connection tests were not sent with those keys. Saved keys stayed masked and saving one category preserved another category's unsaved draft.
- Reproduced and fixed draft loss on the primary Settings link and stale dialog portals on browser Back. Verified rule editor/reset dialogs and model editor history navigation.
- Screenshots are in the ignored `output/playwright/settings-*-final.png` files. Independent read-only code review has no remaining blocking findings.
