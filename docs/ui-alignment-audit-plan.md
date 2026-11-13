# UI alignment audit implementation plan

**Goal:** Repair measured layout defects while preserving Squabble's current visual tokens and workflows.

**Architecture:** Render the compiled client using fictional loopback HTTP fixtures. Capture a fixed scenario matrix before edits, repair disjoint component families, and compare the same matrix afterward. Keep any human-approved baseline separate from run-local evidence.

**Tech stack:** Existing React 19, Tailwind/CSS, Vite, Playwright 1.65, Node test runner.

- [x] Read the supplied SOP, current contributor skill and latest main; create an isolated branch.
- [x] Inspect existing UI and install only the compatible official audit skill.
- [x] Add deterministic probes, fictional fixtures, frozen route matrix and token fingerprints under scripts/ui-probe/ and .ui/.
- [x] Prove the gate rejects missing scenarios, new serious findings, matrix changes and token changes using synthetic Node tests.
- [x] Capture before evidence from the current build; record each defect's selector, bounds and measured threshold before editing.
- [x] Repair roster cards in client/src/features/agent-roster/ and other measured component families without overlapping file ownership.
- [x] Build again, rerun the identical matrix, inspect before/after screenshots and record the net improvement.
- [x] Run applicable client checks, lint, build:web, test:context and check:context; independently review the diff.
- [x] Record architecture no-impact reasoning, tool installation provenance, limits and validation results in .ui/REPORT.md; prepare the reviewable branch for PR delivery.
