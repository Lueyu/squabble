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
| `shared/` | Types shared by front-end and backend |
| `agent/` | Optional Python agent CLI |
| `docs/`, `README*` | Documentation |
| `scripts/db/` | Base schema, opt-in fictional demo seed and migrations |
| `desktop/` | Electron launcher, private PostgreSQL lifecycle and desktop checks |
| `Dockerfile`, `docker-compose*.yml`, `.github/` | Clean local web stack, opt-in demo and installer CI |

The project was originally developed on the Miaoda (aPaaS) cloud; that
coupling has been fully removed, so there is no mirror/sync workflow anymore.

## ✅ How changes reach `main`

1. Create a branch from the current `main` and open a pull request targeting
   `main`. Direct pushes, force pushes and branch deletion are blocked.
2. Keep one feature or fix in each PR. Explain the behavior change, how you
   tested it, and any effect on existing local data, database migrations,
   desktop installers or Docker deployments. Use the PR template.
3. Wait for all six required GitHub checks to pass: **Lint & typecheck**,
   **Agent tests**, **Docker image build**, **Windows x64**, **macOS x64** and
   **macOS arm64**. The PR must be up to date with `main`. Documentation-only
   PRs run these checks too.
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
npm ci               # install the versions in package-lock.json
npm run lint         # eslint + typecheck + stylelint
npm run test:server  # offline server tests
npm run test:client  # client behavior tests
npm run test:desktop # desktop lifecycle tests (Windows/macOS)
npm run test:a2a     # optional local agent bridge tests
```

These checks must pass for application changes. For documentation changes,
check local links, rendered Markdown and commands against the current scripts.
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
