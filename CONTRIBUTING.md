# 🤝 Contributing to 吵股 Squabble

Help make personal investing tools easier to understand and safer to try.
Useful contributions include clearer onboarding, verified research data,
paper-trading rules, privacy controls, translations and bug fixes.
Start with the [local setup guide](docs/self-hosting.md), then use the
[development guide](docs/development.md) if you want to change the app.
If you use an AI coding agent, share the repository's
[Squabble contributor skill](.agents/skills/squabble-contributor/SKILL.md) with it.

## 📁 Project layout

GitHub is the single source of truth — every path accepts normal pull
requests:

| Path | What lives there |
|---|---|
| `client/` | React SPA (pages, components, hooks, api wrappers) |
| `server/` | NestJS backend (modules, first-party auth, platform layer in `server/common/platform/`) |
| `server/local-agents/` | Native research agent detection, login, model configuration and execution |
| `shared/` | Types shared by front-end and backend |
| `agent/` | Optional Python agent CLI |
| `docs/`, `README*` | Documentation |
| `scripts/db/` | Base schema, opt-in fictional demo seed and migrations |
| `desktop/` | Electron launcher, private PostgreSQL lifecycle, local-agent companion and desktop checks |
| `Dockerfile`, `docker-compose*.yml`, `.github/` | Clean local web stack, opt-in demo and installer CI |

The project was originally developed on the Miaoda (aPaaS) cloud; that
coupling has been fully removed, so there is no mirror/sync workflow anymore.

## Current development phase

The project is in a web-only development phase, with `fe9df6c` as the baseline.
Desktop development, testing and packaging are paused until explicitly resumed.
Desktop code and the full **Desktop installers** workflow remain available for
manual recovery through `workflow_dispatch`; pushes, pull requests and version
tags do not start it automatically. Desktop checks and installer builds are
not required for PRs during this phase. Web, server, client, database and
local-agent verification remain in scope.

## ✅ How changes reach `main`

1. Create a branch from the current `main` and open a pull request targeting
   `main`. Direct pushes, force pushes and branch deletion are blocked.
2. Keep one feature or fix in each PR. Explain the behavior change, how you
   tested it, and any effect on existing local data, database migrations,
   desktop installers or Docker deployments. Use the PR template.
3. Wait for all three required GitHub checks to pass: **Lint & typecheck**,
   **Agent tests** and **Docker image build**. The PR must be up to date with
   `main`. Documentation-only PRs run these checks too.
4. Resolve review conversations before merging. Our team convention is for
   maintainers to coordinate merge decisions. GitHub does not currently
   require an approval, so collaborators with write access must honor this
   convention; a green check does not replace addressing review feedback.
5. Merge through the PR after the gates pass. Only maintainers publish release
   tags and change branch protection settings.

The [branch protection rule](https://github.com/Lueyu/squabble/settings/branches)
enforces the PR, checks and conversation gates, including for administrators.
If a check fails, fix the cause on the PR branch and let CI rerun. Do not
disable a check or push directly to `main` to get around a failure.

## ✅ Before you open a PR

```bash
npm ci                     # install the versions in package-lock.json
npm run lint               # eslint + typecheck + stylelint
npm run test:server        # offline server tests
npm run test:client        # client behavior tests
npm run test:local-agents  # native runtime, pairing and durable task tests
```

These checks must pass for application changes. For documentation changes,
check local links, rendered Markdown and commands against the current scripts.
Database integration and memory evaluation remain covered by web CI; see the
[development guide](docs/development.md) for disposable database prerequisites.
`npm run test:desktop` and installer packaging are retained for manual recovery
and become required again only when desktop development is explicitly resumed.
Native-agent tests use fixture executables and disposable task directories;
verification must not start paid research or use personal provider sessions.
For Python agent changes also run:

```bash
cd agent
uv sync
uv run pytest -q     # offline test suite, no live network access
```

## 📝 Guidelines

- **Scope**: one PR per feature or fix. Small, focused PRs get reviewed faster.
- **Commits**: use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:` …) — the history follows this style.
- **Language**: code comments in English; update both Chinese and English UI
  strings. Keep `README.md` and `README.zh-CN.md` aligned when behavior changes.
- **No secrets**: never commit API keys or `db/snapshot/*.sql` (personal data).
- **For demo/seed data** (`scripts/db/02_demo_seed.sql`): keep it fictional,
  plausible and clearly marked as demo data; it must never contain real
  holdings.
- **Database changes**: `server/database/schema.ts` and
  `scripts/db/01_schema.sql` must stay in sync (the SQL file is applied on
  fresh installs; note schema changes in your PR description for existing
  deployments).

## Keep project knowledge current

The repository-owned [Squabble development skill](.agents/skills/squabble-contributor/SKILL.md)
provides a module map, research/execution contracts, testing and deployment runbooks.
New chats should load the relevant reference and inspect changes since its verified
baseline before reading affected source files. Use `npm run check:context` for path
and metadata checks and `npm run test:context` for the helper behavior tests.

Every change includes an architecture and knowledge impact review. Update affected
flows in `docs/architecture.md` and the skill references in the same PR. If structure
is unchanged, record why the existing diagrams remain accurate in the PR; do not
invent diagram changes. Update verification metadata only after reviewing the
source it describes. The helper cannot prove prose or diagram semantics.

After merging an authorized update, preview installation with
`node .agents/skills/squabble-contributor/scripts/sync-skill.cjs --repo .`, then add
`--apply` to synchronize the managed global copy. Keep machine-specific instance
locations in private `~/.squabble/development-context.json`, never in repository
instructions. Installation does not authorize deployments or paid research.

## 🐛 Report a bug

Open an issue with the **Bug report** template. The opt-in Docker demo
(`docker compose -f docker-compose.demo.yml up -d --build`, then log in at
`http://localhost:3001` with `demo` / `demo1234`) is useful for reproduction.
Mention whether the bug also happens with a clean local account or desktop app.

## 💡 Suggest a feature

Ideas are welcome, especially around:

- New analysis pipeline stages or report sections
- Strategy rule types enforced by the risk gate
- LLM provider support in `agent/`
- Paper trading guardrails and manual trade-review workflows
- Anything that makes the self-hosted experience smoother

Label-worthy beginner issues are marked `good first issue`.
