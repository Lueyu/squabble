# Maintain architecture and installed project knowledge

The repository-owned `.agents/skills/squabble-contributor/` is canonical.
The global `$CODEX_HOME/skills/squabble-contributor` (fallback:
`~/.codex/skills/squabble-contributor`) is a discoverable installed copy.
Edit the selected checkout, review/merge it, then synchronize that exact source;
do not maintain two independently edited skills.

## Symptom-to-code triage

Collect the actual release revision, affected record IDs and existing error/status
before choosing a fix. The following are investigation routes, not diagnoses.
Use fictional records in a disposable database to reproduce state-changing paths.

| Symptom | First facts and targeted entrypoints |
|---|---|
| Strategy apply button unavailable | Inspect saved preview `canConfirm`, readiness, issue codes and pending preparation; `client/src/pages/Today/InvestmentStrategyEditor.tsx`, `server/modules/paper-trading/user-investment-strategy.rules.ts`. Missing information may correctly block application. |
| Apply request fails or conflicts | Compare strategy revision, preview hash, expected current strategy and source validity; `user-investment-strategy.service.ts` and `investment-policy.service.ts` in `server/modules/paper-trading/`. Current imports already hash persisted JSONB: verify running release/old draft before assuming the historical ordering bug. |
| `INVESTMENT_NOT_STARTED` | Inspect existing simulation account and policy initialization in `server/modules/paper-trading/investment-policy.service.ts`; do not weaken confirm fences or create a personal account as a diagnostic shortcut. |
| Report missing, old report shown, or raw JSON visible | Compare immutable version/publication outcome and current projection; `server/modules/research-documents/research-documents.service.ts`, `server/modules/experience/current-research.service.ts`, `shared/research-reading.ts`, `client/src/pages/Today/CurrentAnalysisPanel.tsx`. Preserve history and readable error/gap states. |
| Native Agent silent, busy or unreported | Separate discovery/login/provider model metadata from durable task state, lease and progress; `server/local-agents/native.ts`, `server/modules/local-agents/local-agents.service.ts`, `research-journal.ts` in that module. Use fixture executables and existing logs; do not replay charged work to test connectivity. |
| Duplicate channel bubble or misleading execution text | Inspect semantic delta/publication identity, current template/source validity, outbox and authoritative runtime projection; `server/modules/channel/channel-contract.ts`, `channel.service.ts`, `channel-runtime.ts`. Applied rule state is not a fill. |
| Today assets or daily return missing | Inspect price/FX freshness, recorded cash, baseline snapshots and external flows; `server/modules/experience/portfolio-metrics.service.ts` and `portfolio-metrics.ts`. Never infer missing sale proceeds from a position screenshot. |
| Repeated import or wrong cash/position total | Identify snapshot versus transaction import, preview/receipt/idempotency and checkpoint order; `server/modules/import/import-batches.service.ts`, `transaction-imports.service.ts`, `position-checkpoint.ts`. Reproduce with fictional overlapping screenshots/transactions. |
| Market rule does not execute | Inspect confirmed strategy revision, market clock, quote freshness, expiry, sizing/lot/cash/risk and source fences; `server/modules/paper-trading/user-strategy-runtime.ts`, `strategy.service.ts`, `strategy-route.rules.ts`. Generic observation text need not constitute an executable directive. |

Use [development-and-tests.md](development-and-tests.md) for the relevant test
families and [deployment-and-recovery.md](deployment-and-recovery.md) for runtime
discovery. Inspect the affected source and record why the proposed change addresses
the observed failure; a successful health endpoint alone does not validate any row.

## During every change

1. Run `node <skill>/scripts/inspect-workspace.cjs --repo <root>`. Confirm
   root, branch/revision, changed paths and freshness baseline. Read
   `context-manifest.json` and the affected references, then inspect the
   authoritative source entrypoints. A manifest can guide the search but cannot
   establish runtime semantics by itself.
2. Assess the change against the five flows in `docs/architecture.md`:
   system boundaries, research/report publication, strategy import and
   execution, channel publication, and real asset/transaction ledger. Check
   ownership, trust boundaries, source identity, canonical hash/idempotency
   contracts, data lifecycle and background/recovery behavior where affected.
3. Update affected diagrams, prose, entrypoint map and operational/test guidance
   in the same change. Route/contract/state/migration/deployment changes usually
   need knowledge updates even when the UI looks identical. Update corresponding
   English/Chinese product documentation when it exists and behavior changes.
4. If architecture or skill content does not change, record explicit no-impact
   reasoning in the PR and the manifest's review notes where appropriate.
   Example: “Styles only; inspected route, API and persistence boundaries;
   unchanged.” Do not redraw diagrams for a styling change or advance a
   verification baseline without actually reviewing its source.
5. Record verification metadata per the manifest's existing structure: reviewed
   source revision/baseline, review date and affected area/review outcome.
   Describe source changes after a baseline instead of claiming a worktree is
   already represented by a commit that does not exist yet. Do not replace
   area-specific review with a blanket “up to date.”
6. Run the context helper tests/checks, local link/frontmatter checks and
   relevant application verification. Record skipped integration cases,
   unavailable prerequisites and remaining drift honestly. Inspect the final
   diff for private paths, credentials, real portfolio data and accidental
   generated artifacts.

Useful commands from the selected root:

```sh
node .agents/skills/squabble-contributor/scripts/inspect-workspace.cjs --repo .
node .agents/skills/squabble-contributor/scripts/check-context.cjs --repo .
npm run test:context
npm run check:context
git diff --check
```

Read each helper's `--help` for supported options. The inspector and checker
must remain read-only: no dependency installation, fetch, migration, service
restart, external model request or strategy action. They do not validate a live
instance or grant authority to operate it.

If Git inspection reports a permission/worktree access failure, distinguish execution
permissions from repository corruption. Retry read-only inspection in an execution
context allowed by the existing authorization; do not rewrite `.git`, reconstruct a
worktree or reset user changes to make the inspector run. Report unavailable Git
facts as unknown if access remains unavailable.

## Mechanical checks versus semantic review

| Mechanical evidence | Review still required |
|---|---|
| Referenced files exist and metadata parses | Entrypoints still implement the documented flow |
| Changed paths map to knowledge areas | Indirect callers, shared contracts and background jobs are covered |
| Migration registry names exist | Fresh/upgrade behavior preserves schema, keys and existing data |
| Local links and Mermaid syntax pass | Diagram direction, ownership and current-versus-legacy distinctions are accurate |
| Installed files match the managed manifest | The source revision is the intended reviewed release |
| Test/CI commands pass | Tests cover the changed risk and do not merely skip integration |

`check-context` is a drift/structure guard, not a semantic proof. When it
passes, still read changed source and its documented contract. When it warns,
investigate the actual change; do not edit a timestamp just to make it quiet.

For substantial skill changes, use a fresh agent with only the skill plus
task-relevant references. Ask it to locate a specific feature, choose exact
tests, identify a live instance without mutations, and describe backup,
cutover and rollback. Include a case where the installed copy is older than
the checkout. It should verify source authority and avoid hardcoded paths,
permanent PIDs, missing test variables or paid/live research. Preserve the
scenario outcome with the PR; correct gaps and repeat the affected scenario.

## After merge: synchronize one installed copy

From the checkout of the reviewed merged revision, preview first:

```sh
node .agents/skills/squabble-contributor/scripts/sync-skill.cjs --repo .
```

Inspect the source/destination and planned files, then apply when installation
is within the authorized task:

```sh
node .agents/skills/squabble-contributor/scripts/sync-skill.cjs --repo . --apply
```

For a disposable installation test, pass `--destination <temporary-directory>`
to both commands. The helper records provenance and refuses unsafe/unmanaged
or locally modified destinations. A refusal is a reconciliation task: inspect
the existing copy, preserve customization and decide which source to keep.
Do not bypass it with recursive deletion, force overwrite or a blind copy.
Updates buffer and hash source resources, retain a bounded backup of affected files,
and atomically replace each file. A caught write failure restores previous managed
files and the installation stamp. If rollback is incomplete, preserve the reported
backup and its `recovery.json` and reconcile those exact files before retrying; do
not blindly delete the destination. An abrupt process/OS termination may also leave
a recovery backup; validate the stamp and managed hashes before reusing the copy.

Re-run validation against the installed files and verify its recorded source
revision. Update the private locator only for verified repository/instance
locations; never copy private state into the skill.

The GitHub rules and current CI remain authoritative for merging. Keep the
three required checks and maintainer review convention; skill installation
does not replace PR checks or authorize an application deployment.
