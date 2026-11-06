# Squabble Development Skill Implementation Plan

> **For agentic workers:** Use subagent-driven development for independent references, helper implementation and fresh-agent validation. User approved design and execution; no repeated approval is needed.

**Goal:** Install a reusable Squabble development skill with accurate repository knowledge, operational runbooks and an explicit maintenance loop.

**Architecture:** The repository owns the skill; a validated installation copy enables discovery in new chats. Focused references route to current source entrypoints and repository-owned architecture diagrams. A manifest and small read-only tools detect stale paths and guide incremental inspection.

**Tech Stack:** Markdown, Mermaid, YAML, Node.js built-ins, Git, node:test.

## 1. Baseline and design
- [x] Run a new-agent baseline against the old skill; record missing entrypoints, deployment procedures and stale DB guidance.
- [x] Write the approved design and this plan; confirm clean isolated branch from main.

## 2. Repository knowledge and architecture
Files: skill `references/repository-map.md`, `references/research-and-execution.md`, `docs/architecture.md`.
- [x] Map actual current routes, modules, contracts and database ownership; distinguish retained legacy behavior.
- [x] Document report/strategy canonical hashes, source isolation, simulated execution and channel publication contracts.
- [x] Maintain five Mermaid diagrams and verify referenced source paths.

## 3. Development and operational references
Files: skill `references/development-and-tests.md`, `references/deployment-and-recovery.md`, `references/maintenance.md`, `docs/development.md`, `docs/self-hosting.md`.
- [x] Write source/Docker setup and isolated DB test matrix using package.json and CI.
- [x] Write instance discovery, backup, safe cutover, read-only verification and rollback procedures. Treat ignored temporary scripts as nonportable examples only.
- [x] Correct obsolete migration ranges and Windows process cleanup claims without changing app code.

## 4. Helpers and executable verification
Files: skill `scripts/inspect-workspace.cjs`, `scripts/check-context.cjs`, `scripts/sync-skill.cjs`, helper library if needed; `scripts/squabble-context.spec.cjs`.
- [x] First add behavior tests using temporary repositories/destinations. Required cases: inspection does not modify files; changed entrypoint maps to affected references; missing paths fail; remote credentials are not printed; install/update is bounded and refuses unmanaged or locally modified destination.
- [x] Run `node --test scripts/squabble-context.spec.cjs`; observe missing helpers fail before implementation.
- [x] Implement the helpers using Node built-ins and execFile argument arrays; no shell-built commands. `--repo` selects a worktree; `--help` documents arguments. Mutating sync requires `--apply`; otherwise show a plan.
- [x] Run the same tests green; validate helpers on the actual repository without touching live application state.

## 5. Entrypoint, metadata and contribution integration
Files: skill `SKILL.md`, `agents/openai.yaml`, `context-manifest.json`; `CONTRIBUTING.md`, PR template, `package.json`, CI.
- [x] Keep the entrypoint concise and discovery automatic; link only task-relevant references.
- [x] Manifest records verification baseline, area paths, entrypoints and references; maintain meaningful architecture review notes.
- [x] Add `test:context` and `check:context` commands and CI steps for developer tools. Preserve the existing three required checks and web-only scope.
- [x] Add maintenance completion reminders to contributor instructions and PR template.

## 6. Validation, merge and installation
- [x] Run `python -X utf8 "$env:USERPROFILE/.codex/skills/.system/skill-creator/scripts/quick_validate.py" .agents/skills/squabble-contributor`.
- [x] Run `npm run test:context`, `npm run check:context`, `npm run lint`; validate Mermaid and local documentation links.
- [x] Independent fresh agent uses only skill and relevant references to locate report import/confirmation, choose tests, plan current instance discovery and list required documentation updates; second scenario covers channel publication/strategy state without live mutations.
- [x] Review actual diff, tracked ignored skill resources, secret exclusion and installation boundaries.
- [ ] Open PR, attach it, wait all required CI, merge exact reviewed head.
- [ ] Install verified merged skill globally; create private environment locator; verify installed references/provenance and helper behavior. Existing application instance stays running.
