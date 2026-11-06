# Squabble development skill design

Approved by the user on 2026-11-07 (Asia/Shanghai): extend the existing contributor skill, keep one repository-owned source, install a discoverable global copy, and maintain architecture and project knowledge with each change.

## Outcome and scope
A fresh chat identifies current product entrypoints, tests and deployment procedures from a concise skill and focused references. It checks repository drift and reads only affected source files. This task changes developer knowledge and tools, not application behavior or the running investment instance.

## Ownership and structure
Canonical source: `.agents/skills/squabble-contributor/`. Global installed copy: `$CODEX_HOME/skills/squabble-contributor`, falling back to `~/.codex/skills/squabble-contributor`. Keep automatic discovery enabled. Prefer canonical knowledge in the selected checkout; global resources remain usable for locating a configured project. An install stamp identifies its source revision. Do not maintain two independent copies.

The entrypoint routes to `references/repository-map.md`, `research-and-execution.md`, `development-and-tests.md`, `deployment-and-recovery.md`, and `maintenance.md`. `docs/architecture.md` owns five Mermaid diagrams: system, research/report, strategy execution, channel publication and real asset ledger. Explain current versus retained legacy routes. Correct stale migration and Windows startup guidance in existing docs.

## Tools and private state
Provide Node helpers for read-only workspace inspection, knowledge validation and explicit installation/synchronization. Inspection shows Git identity, changed paths, reference freshness, registered migrations and entrypoints without reading secret values, modifying services or scanning all source contents. A manifest maps business areas to authoritative entrypoints and relevant references; its verification revision is a baseline, not a claim that future source is unchanged.

Local deployment locators live under private `~/.squabble` state. Store repository/instance/config locations, bind address and database version hints; exclude passwords, tokens and persistent PIDs. Confirm actual process/cluster identity before operational actions. A locator and a skill never grant execution authority.

Installation validates source and destination, refuses destructive overwrite of unmanaged/customized copies, records provenance and supports disposable-target tests. Source changes are maintained in the repository and synchronized after merge. Inspection/validation never automatically install dependencies, fetch, migrate, contact models, apply strategies or restart services.

## Required maintenance
Each change checks architecture and skill impact. Update affected flow/contract/entrypoint documentation in the same change. If structure did not change, record a review result rather than inventing diagram edits. Record verification metadata and explicit no-impact reasoning. Update installed knowledge after merge. Add repository contribution/PR reminders and run the helper tests/knowledge checks in CI without changing existing required gates.

## Validation
Baseline: an independent agent using only the old skill and directly referenced docs could not locate daily strategy import/confirmation entrypoints or discover and safely update a live source instance; it also inherited stale migration guidance. Repeat realistic read-only tasks against the new skill using independent agents. Test helper behavior with temporary Git repositories and destinations: missing/stale paths, read-only inspection, credential redaction, update drift, managed install/update and refusal to overwrite unrelated content. Validate skill frontmatter, all reference paths and Mermaid syntax. Run lint and existing required CI before merging. Do not run personal research or deploy the application for this documentation task.
