# 🔧 Development Guide

This guide is for changing Squabble's code. To use the product, start with
the [desktop app or clean local Docker installation](self-hosting.md).
For pull requests, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Requirements

- Node.js >= 22, npm >= 10
- PostgreSQL 16 and its `psql` client for source development
- Python 3.12 + [uv](https://docs.astral.sh/uv/) only if developing the optional
  Python agent; the web application's analysis does not require it
- The npm scripts use `cross-env` for Windows-compatible environment settings.
  The development supervisor's port cleanup uses Unix utilities; on Windows,
  stop any conflicting processes yourself before starting it.

## Run modes

| Mode | How to start | Database | Best for |
|---|---|---|---|
| Clean local Docker | `docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build` | containerized PostgreSQL, no demo seed | Use a local account and empty workspace |
| Optional fictional demo | `docker compose -f docker-compose.demo.yml up -d --build` | separate PostgreSQL volume with demo seed | Explore fictional examples on port 3001 |
| Source: full stack | `npm run dev` | via `DATABASE_URL` (local PostgreSQL) | Everyday development |
| Source: backend only | `npm run dev:server` | same | API work |
| Source: client only | `npm run dev:client` | proxies `/api` to :3000 | UI work |

Desktop and the source `.env.example` use a local workspace without a Squabble
login. Docker and backends with no `AUTH_MODE` configured retain username/password
authentication and JWT sessions. GitHub is the source of truth; no Miaoda account
is needed to run it.

## Start from source

1. Clone the repository and run `npm ci` in its root.
2. Create a new PostgreSQL database for this project. Initialize its **empty**
   schema with `psql -d YOUR_CONNECTION_URL -v ON_ERROR_STOP=1 -f scripts/db/01_schema.sql`.
   Do not run the base schema against an existing populated installation.
   The optional `02_demo_seed.sql` adds fictional demo records; leave it out
   for an empty workspace.
3. Create a private `.env.local` in the repository root using `.env.example`.
   It is ignored by Git:

   ```dotenv
   DATABASE_URL=postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/portfolio
   JWT_SECRET=YOUR_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
   SETTINGS_ENCRYPTION_KEY=ANOTHER_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
   AUTH_MODE=local
   SERVER_HOST=127.0.0.1
   SERVER_PORT=3000
   TRUST_PROXY=false
   LOCAL_APP_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
   LOCAL_AGENTS_MODE=native
   ```

   Replace every placeholder. To generate each secret independently, run
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
   Avoid committing credentials or pasting them into an issue.
4. Run `npm run dev`. It loads `.env.local` before `.env` and starts Nest and Vite;
   existing shell variables take precedence. Open
   **http://localhost:8080** for the frontend; the API is on port **3000**.
   Vite proxies `/api` to `127.0.0.1:3000`. Local mode opens the workspace directly.

Use available ports: the development supervisor attempts to stop processes on
its configured ports. Do not run it over an existing Docker app on port 3000.
Logs are under `logs/`; inspect them if startup fails. The individual
`dev:server` and `dev:client` commands do not use that supervisor; provide the
required environment variables in their shell when running them separately.

The app applies additive migrations `03` through `15` on startup. They do not
create the base schema. Neither Docker configuration publishes PostgreSQL on
the host, so a source development server cannot reach it at `localhost:5432`
without an explicit local port mapping.

## Local workspace mode

`AUTH_MODE=local` requires a loopback `SERVER_HOST` and `TRUST_PROXY=false`.
It is for a single trusted local workspace. The frontend reads `/api/auth/mode`
before opening it; login, logout and account recovery are hidden in this mode.
For Vite, list the actual frontend origins in `LOCAL_APP_ORIGINS`, separated by
commas. Update those origins if you change `CLIENT_DEV_PORT`.

An empty database receives an internal `local-workspace` identity. A database
with one existing user reuses that user's data. If it contains multiple users,
set `LOCAL_WORKSPACE_USER_ID` to the existing user's ID whose workspace you want
to open; startup will otherwise stop rather than choose one. This selects data
without deleting, merging or renaming accounts, holdings or saved credentials.
Native agent connections are shared by this local installation and no longer
depend on their legacy Squabble account owner; provider CLI login still applies.

Set `AUTH_MODE=account` to retain username/password login, registration and
recovery. Omitting `AUTH_MODE` from a directly started backend also preserves
account mode for existing deployments. Desktop supplies `local` by default but
honors an inherited `AUTH_MODE=account` and `LOCAL_WORKSPACE_USER_ID`. Docker
continues to use account mode. Do not expose local mode through a public bind,
reverse proxy or tunnel.

## Lint, types, tests

```bash
npm run lint          # eslint + stylelint + full typecheck (also runs in CI)
npm run test:server   # Nest service/rule tests; database suites need the variables below
npm run test:client   # client state and component behavior
npm run test:desktop  # bundled database, lifecycle and loopback security checks
npm run test:local-agents # native CLI fixtures and companion ownership/lease checks
npm run type:check    # typecheck only
```

Database integration suites use `BUDGET_TEST_DATABASE_URL`, `COUNCIL_TEST_DATABASE_URL`, and `AUTH_TEST_DATABASE_URL`. Set them to a **disposable test database** initialized with `01_schema.sql` and additive migrations `03`–`15`; do not point them at personal or production data. Without these variables, database cases are explicitly skipped. CI provisions PostgreSQL and runs them, including concurrent reservations, user isolation, first-account registration, discussion revisions, and atomic paper execution.

Agent service:

```bash
cd agent
uv sync
uv run pytest -q      # offline suite, no live network access
```

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and pull requests
targeting `main`: webapp lint, typecheck and server/client tests; Python agent
tests; and a Docker image build.

The separate desktop workflow builds Windows x64, macOS x64, and macOS arm64
installers. It runs the desktop tests and verifies a fresh packaged app can
start its own database and API before publishing version-tagged installers.

## Native research agents

Use [Settings to connect a supported research agent](local-agents.md). Desktop starts the
backend with `LOCAL_AGENTS_MODE=native` and a private `LOCAL_AGENTS_DATA_DIR` under its
application data directory. Source development can use native mode with the loopback
host shown above. Docker uses `LOCAL_AGENTS_MODE=companion` and persists state in the
`local-agents-data` volume at `/app/.local-agents`.

The desktop handles `squabble://pair` links only after validating a literal loopback
origin and showing a native confirmation dialog. It polls the paired app outbound;
native tasks run asynchronously so progress and cancellation do not block heartbeats.
Task IDs are journaled before launch and are never replayed after a helper restart.
The native runner lives in `server/local-agents/native.ts`; Electron loads the built
CommonJS module from `dist/server/local-agents/native.js` at runtime. Build both the
backend and desktop before exercising the helper.

Tests use fixture executables and disposable pairing stores, without paid model
calls. `npm run test:desktop` covers pairing validation, private persistence,
redirect rejection, cancellation and duplicate delivery as well as database lifecycle.

## Python Agent (`agent/`)

An optional CLI scaffold for experimenting with external agents. It talks to
the webapp over HTTP (`WEBAPP_BASE_URL` in `agent/.env`) rather than connecting
to the database. It is separate from the built-in NestJS analysis pipeline.
Its legacy gateway must be explicitly enabled and configured by the operator;
it is disabled in both shipped deployment paths.

```bash
cd agent
cp .env.example .env          # fill in ARK_API_KEY / DEEPSEEK_API_KEY
uv run agent health           # check the webapp client
uv run agent quote AAPL       # fetch a real quote through the webapp
```

`agent/src/agent_core/` currently supplies CLI commands, an HTTP client, a
model adapter and JSONL checkpoints. A complete ReAct/planning runtime and
tool orchestration are not implemented there. See [architecture](architecture.md)
for the implemented webapp and MCP integration paths.

## Design tokens & theming

Base colors, fonts, radii and shadows live in `client/src/tailwind-theme.css`;
`client/src/themes.css` supplies the four visual styles and their dark variants.
Pages consume semantic tokens (`bg-background`, `text-muted-foreground`, …).
Use `useTheme` for shared preferences and `useChartTheme` for canvas colors.
Card defaults live in the components layer so explicit border, shadow and ring
utilities can still communicate selection, errors and drag targets. Financial
profit/loss colors stay green/red independently of decorative brand accents.
See the [appearance guide](appearance.md) for storage keys, components and
the complete visual verification checklist.

## Database schema

Keep the Drizzle definitions in `server/database/schema.ts` and fresh-install
SQL in `scripts/db/01_schema.sql` consistent. Existing installations also
need an additive migration under `scripts/db/`, registered in
`server/common/platform/database.provider.ts` and copied by the Dockerfile.
The repository has no `gen:db-schema` npm script. Test both fresh installs and
upgrades when changing the schema, preserving existing user data.

## Platform migration notes

The webapp was originally developed on the Miaoda (aPaaS) cloud. Runtime
authentication now supports local workspaces and first-party username/password
sessions in `server/modules/auth`, and the database layer is a direct Drizzle connection
in `server/common/platform`. The development supervisor still contains the
optional legacy initialization step noted above. Use the environment values
shown in this guide for source development; the supported end-user paths are
described in [local installation](self-hosting.md).
