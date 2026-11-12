# UI regression repair validation

Date:2026-11-13. Reviewed source baseline:`261f07ce17b80fef7dfe525725a711e72b0f63de` plus the UI repair working tree. This is a source and verification record, not a released or deployed revision. The [design](ui-regression-repair-design.zh-CN.md) states the requested behavior; the [plan](ui-regression-repair-plan.md) tracks remaining work.

## Reviewed scope

- Stable roster animal identity, editable working instructions/preferences and language-aware recommended creation. Profile appearance changes stay separate from immutable capabilities; new conversations and commissions freeze identity while historical snapshots keep their fallback.
- Investment and Holdings are separate primary destinations. Simulation-account labels, valid internal returns, import-save continuation and exact commission-history links use existing routes.
- Owner-partitioned tab drafts, verified migration of old unscoped progress and exact retained payload/key recovery for interrupted guided startup. Resolved obsolete progress retains created resources and receipts.
- Real selected participants in research and team displays, with budget caps separate from observed spending.
- Five daily destinations are visible in the mobile navigation. New-chat participants collapse behind an explicit adjustment control, and body-portalled dialogs share the active workspace palette. The simple holdings context avoids links already present in section tabs; the watchlist scope notice remains owned by the watchlist page and is absent from holdings/ledger context.
- CSV and screenshot save recovery retains the original batch, complete payload and key while the outcome is unknown; the UI blocks editing, switching import modes and changing the research choice until that save settles. Screenshot recovery reads existing receipts before retrying the identical save.

## Measured checks

The following checks were executed in this working tree. Local evidence logs are ignored under `output/playwright/ui-repair/`; they are not committed artifacts or deployed-instance proof.

| Check | Observed result | Local log |
|---|---|---|
| `npm run lint` final combined-source run | Passed:ESLint, server/client TypeScript and Stylelint, exit0, before the final removal of one misplaced holdings notice | `lint-release-final.log` |
| `npm run build:web` final combined-source run | Passed, exit0, before the final copy-only removal; follow-up `npm run build:client` also passed after that removal | `build-web-release-final.log`; final client rebuild |
| `npm run test:architecture` |10 passed,0 failed/skipped | `test-architecture.log` |
| `npm run test:context` before documentation updates |15 passed,0 failed/skipped | `test-context.log` |
| `npm run check:context` before documentation updates |`valid=true`, no errors; expected semantic-review warning and `review-required` drift | `check-context.log` |
| `npm run test:dev` |8 passed,0 failed;1 POSIX-only case skipped on Windows | `test-dev.log` |
| `node --test --test-concurrency=1 client/src/utils/agent-animal-identity.test.cjs` |5 passed,0 failed/skipped | `backend-avatar-dom.log` |
| Focused roster/Council/Teams database suite below |82 passed,0 failed/cancelled/skipped | `backend-roster-team-focused.log` |
| Fresh-schema generation comparison |Read-only reconstruction matched the checked-in `01_schema.sql`, composed from63 registered migrations including66 | `backend-fresh-schema-parity.log` |
| Documentation link and architecture-block check |90 local links resolve; five Mermaid blocks and five anchors present; `git diff --check` passed | Targeted documentation check |
| `npm run check:context` after knowledge edits |`valid=true`, no errors; expected semantic-review warning and `review-required` drift | `check-context-after-docs.log` |
| `npm run test:context` after knowledge edits |15 passed,0 failed/skipped, exit0 | `test-context-after-docs.log` |
| Independent documentation/skill review |No findings in source claims, baseline metadata, links/table syntax, paths or pending acceptance gates | Read-only peer review |
| Team/research adjacent client regressions |128 passed,0 failed/skipped across18 files | `teams-research-adjacent-focused.log`, `teams-research-verification.json` |
| Import continuation and screenshot regressions |45 passed,0 failed/skipped; includes real React DOM, Query and API-wrapper behavior with fictional HTTP | Targeted import repair run |
| Guided startup permission-change regressions |40 passed,0 failed/skipped; definite authority rejection permits a safe end, while network/408/429/5xx outcomes retain the exact pending request | Targeted guided repair run |
| Mobile navigation and research-composition regressions |29 passed,0 failed/skipped; targeted TypeScript, ESLint and Stylelint checks passed | Targeted mobile repair run |
| Appearance scope and holdings-context regressions |30 passed,0 failed/skipped; targeted lint/style checks passed | Targeted visual-polish run |
| Final holdings-context copy regression |3 passed,0 failed/skipped after removing the watchlist-only notice from holdings/ledger context; independently rerun with the same result; selected account and unique team link retained | `account-context-final-red.log`, `account-context-final-green.log`; independent `account-assets-context.test.cjs` run |
| Independent final code review and regression rerun |No actionable P1/P2 findings; import continuation, screenshot import and guided resume:72 passed,0 failed/skipped | Read-only peer review and independent targeted run |

The focused database command was:

```sh
npx tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/agent-roster/*.spec.ts server/modules/council/council-roster.integration.spec.ts server/modules/council/simple-council.roster.spec.ts server/modules/council/council.team.spec.ts server/modules/teams/*.spec.ts
```

`AGENT_ROSTER_TEST_DATABASE_URL`, `TEAM_TEST_DATABASE_URL` and `COUNCIL_TEST_DATABASE_URL` pointed to a disposable PostgreSQL16 fixture. Real services and persistence used fake model transports. Cases covered ordinary conversation receipt replay, frozen old/new avatars and preferences, deterministic migration66 backfill, retained version/receipt contents, chosen avatars after replay, actual Team→Council snapshots, source/owner fences and fresh versus baseline60 upgrade/replay parity. No personal model or portfolio records were used.

These focused runs overlap and must not be added together as a unique test total. An earlier complete client run passed607/607 with no skips, before the last import, mobile and appearance repairs. Final lint, Web build and the follow-up client rebuild passed as recorded above; the final complete client suite remains pending in this record. Complete native and server checks also remain pending. The knowledge-helper rerun above validates the edited paths and helper behavior; it does not establish semantic freshness or deployed behavior.

## Interactive browser evidence

Playwright used a loopback-only fictional HTTP gateway serving the compiled client. It did not forward requests to personal services or call a model. Root inspection of the captured images confirmed the following journeys; these observations are distinct from DOM-only assertions:

- At1440×1000, create a stock friend with the fox animal, save, reload and confirm the persisted animal card. Investment, holdings, teams and research routes rendered without horizontal overflow or JavaScript page errors.
- At390×844, inspect friends, the animal editor, holdings, investment, guided teams and single-agent research. After rebuilding the repairs, all five daily pages had no horizontal overflow or page errors; the bottom navigation showed all five destinations including Holdings. The collapsed research summary and composer were visible in the first viewport. Scroll the mobile animal dialog, save a selection, then reload and confirm the saved animal.
- Recheck the1440×1000 desktop main pages without horizontal overflow. Dialog backgrounds matched the active palette in classic light (`rgb(255,255,255)`), classic dark (`rgb(14,16,19)`) and arcade (`rgb(238,238,218)`); each retained the simple workspace scope and had no page errors. Root visually inspected the final research and dialog screenshots. A final copy-only review removed the misplaced watchlist scope notice from holdings; its rendered regression passed3/3.
- Complete guided startup through the real UI with fictional HTTP: enter a team name, select the saved fox agent, review a7 USD cap, refresh, confirm the cap is retained, then explicitly authorize startup. The full create/publish/account/binding/agreement/start sequence reached the matching team page showing the running state, without overflow or page errors.
- Upload a fictional CSV, review it, choose the primary save action and follow “下一步：认识股友” to the roster. The saved HTTP payload had `analyze:false`; this continuation did not schedule research.

Screenshots and the gateway/scenario scripts remain local ignored evidence under `output/playwright/ui-repair/`. Theme/mobile visual rechecks passed. Exact history links and account-scoped returns have regression coverage, but an interactive commission-history acceptance scenario has not been exercised in this browser fixture.

## Recovery limits

Guided team drafts and startup progress are stored in owner-partitioned session storage and are covered for refresh and returning from the roster. Each outstanding startup mutation must settle through its original receipt before changed authority can allow the flow to end.

Import save recovery is currently held in component memory. This repair protects same-page retries and mode/batch changes while an outcome is unknown; persistence across a full refresh or leaving the page has not been added or verified. A persisted screenshot batch can be reopened, but that is not a claim that the exact unknown save intent survives page reload.

## Architecture and knowledge review

All five maintained diagrams were inspected. System ownership retains the existing modules; the navigation prose now names five daily destinations. New animal/profile identity and frozen conversation/commission display fields fit the existing roster and research edges. Guided browser cache recovery preserves the existing server agreement, receipt and final apply boundaries. Channel source seals and explicit real-ledger writers remain unchanged; import completion adds a navigation choice rather than implicit research or an order.

The repository-owned contributor skill, module map, research/execution contracts, targeted tests and deployment notes now describe migration66, frozen appearance, shared working instructions and owner-scoped guided caches. Manifest review metadata records the actual baseline plus working-tree changes. The older `verifiedCommit` remains intact rather than claiming an uncreated release commit.

## Pending acceptance and delivery gates

- Interactive commission-history acceptance remains unperformed; exact history-link and return-state regressions are passed. The completed desktop/mobile, theme, animal, CSV and guided-startup journeys are listed above; a DOM assertion is not visual acceptance.
- Final focused and complete application verification with documented disposable prerequisites. Missing prerequisites or skipped integration are not passes. The Windows POSIX-only dev skip is recorded above.
- Independent specification and code-quality reviews have resolved the identified template-tool, import-unknown and guided-authority findings. The final independent review found no actionable P1/P2 issues; new changes still require appropriate review.
- PR and all required protected checks: **Lint & typecheck**, **Agent tests**, **Docker image build**. No final CI/merge result is recorded here yet.
- Managed skill synchronization after merge, verified backup/isolated-restore migration66 acceptance, controlled local release switch and read-only deployed revision/bundle checks. No deployment or personal-data mutation has been performed by this documentation/static-check task.
- The five-participant novice study remains unperformed; automated or browser checks cannot establish that usability target. Paid provider compatibility, real external-agent bills and investment quality are separate evaluations.
