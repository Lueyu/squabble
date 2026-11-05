---
name: squabble-contributor
description: Use when contributing code or documentation to Lueyu/squabble, preparing a pull request to main, or checking the project's merge requirements.
---

# Squabble contributor

Use this skill for changes to `Lueyu/squabble`. Read the repository's
`CONTRIBUTING.md` and `docs/development.md` for the current project details.
The GitHub branch rule and CI are authoritative if a copied skill becomes stale.

## Current development phase

The web-only phase starts from baseline `fe9df6c`. Desktop development, testing
and packaging are paused until explicitly resumed. Do not require desktop
tests or installer builds for PRs during this phase. Preserve web, server,
client, database and local-agent tests. The full Desktop installers workflow
remains available through manual `workflow_dispatch` for recovery only; it does
not run automatically on pushes, PRs or version tags.

## Prepare the change

1. Start from current `main` on a separate branch. Make one focused change per PR.
2. Keep local user data and credentials out of commits. Demo data must be fictional.
3. For behavior changes, update relevant tests and both Chinese and English UI
   text or docs. For database, Docker or desktop changes, describe how existing
   installations keep data and how the change was verified.
4. Run `npm run lint` and relevant tests from `CONTRIBUTING.md`. For `agent/`
   changes, run `uv run pytest -q` inside `agent/`. Record any test you could
   not run and why; CI still has to pass.

## Open and merge the PR

- Target `main` through a pull request and fill in the PR template: what and
  why, verification, and data or release impact. Link an issue when relevant;
  an issue is not mandatory.
- Wait for the three required checks: **Lint & typecheck**, **Agent tests**
  and **Docker image build**.
  Keep the PR up to date with `main` and resolve review conversations.
- A green CI run does not grant permission to bypass maintainer feedback.
  GitHub currently does not require an approving review. As a team convention,
  let maintainers coordinate merges; collaborators with write access can merge
  without an approval, so they must follow this convention. Maintainers
  publish releases.
- Never push, force push or delete `main`, or weaken a required check to get a
  PR through. If a check fails, fix the branch and let CI rerun.
