# Private deployment, discovery and recovery

This runbook covers source releases and local/private Docker deployments.
It does not promise supported public hosting. Keep `AUTH_MODE=local` on
loopback with `TRUST_PROXY=false`; a reverse proxy or tunnel is not a safe
extension of local mode. Root Compose binds its host port to loopback and
uses account mode. `deploy/compose.public.yml` is not the default install
path or authorization to expose an instance.

A development task, locator, health endpoint or this skill does not authorize
restarting a personal installation, migrating its database, generating research
or executing strategies. Prepare read-only discovery and an exact release plan
within the user's requested scope. Perform operational mutations only when
that scope authorizes them.

## Locate the actual instance

Run `node <skill>/scripts/inspect-workspace.cjs --repo <root>`, optionally
with `--config <private-path>`. The default private locator is
`~/.squabble/development-context.json`, outside Git. Its schema is:

```json
{
  "schemaVersion": 1,
  "repositories": [{ "root": "C:/work/squabble" }],
  "instances": [{
    "name": "local-source",
    "releaseDirectory": "C:/apps/squabble/releases/example",
    "baseUrl": "http://127.0.0.1:3000",
    "environmentFile": "C:/private/squabble.env",
    "databaseVersionHint": "PostgreSQL 16; verify live server"
  }]
}
```

Values are examples, not this machine's configuration. Paths, bind/port in
`baseUrl`, and version hints aid discovery; they are not live truth. Store no
credentials, connection URLs with passwords, tokens, provider sessions or
permanent PIDs here. Keep secrets only in the private environment file/key
store. Inspection reads locator metadata, not secret values, and does not probe
or change services.

For Windows, discover listeners and process identity without exposing command
lines or environment values:

```powershell
$squabblePort = 3000 # Replace from the verified instance hint.
$squabbleListeners = Get-NetTCPConnection -State Listen -LocalPort $squabblePort -ErrorAction SilentlyContinue
$squabbleListeners | Select-Object LocalAddress, LocalPort, OwningProcess
$squabbleProcessIds = @($squabbleListeners.OwningProcess)
Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -in $squabbleProcessIds } |
    Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath
```

Inspect the matching launcher/service definition and, only as needed, the
selected process's command line locally to establish its absolute entrypoint,
working directory and parent supervisor. Do not dump all command lines to a
chat: arguments may contain secrets. A relative `dist/server/main.js` command
does not prove which checkout runs it. Use the service's working-directory
configuration, verified startup log or development session record
(`node_modules/.cache/squabble-dev.json`) as supporting evidence; corroborate
PID plus creation time against live processes. Recheck identity before any
stop, since PIDs can be reused. Never stop all Node or PostgreSQL processes.

For Docker, use `docker compose ls`, `docker compose ps`, selected container
image/labels and volume mounts to establish project, config files and release.
Keep the same project name and `-f` set throughout. Avoid printing
`docker compose config` or full container inspection, which can reveal secrets.
For a managed service, inspect its configured account, working directory and
launcher instead of guessing from the current shell.

Using the instance's existing private connection method, query PostgreSQL
read-only: `SELECT current_database(), current_user, inet_server_addr(),
inet_server_port(), version();`. If permitted, `SHOW data_directory;`
identifies the cluster. Do not print the connection URL or key values. Confirm
the connection comes from the actual launch environment, including overrides,
not just a similarly named `.env` in the development checkout. Inventory
expected schema objects and current release revision. A filename suffix is
not a live migration version.

## Prepare and back up before cutover

1. Record current release root/revision, listener and supervisor identity,
   startup command/config location, DB identity and PostgreSQL major version,
   Compose project/image digest if relevant, and the verified native-agent data
   directory. Default source agent state is `~/.squabble/local-agents`;
   `LOCAL_AGENTS_DATA_DIR` overrides it. Keep this record private.
2. Prepare a separate release directory at the reviewed revision. Run
   `npm ci`, relevant checks and `npm run build:web` there. Do not rebuild
   the running release in place. Include `dist/`, runtime dependencies and
   all registered `scripts/db/` files. The process must run from that release
   root because both SQL and static assets resolve against `process.cwd()`.
3. Inspect migration and compatibility changes before starting the new backend.
   It applies registered SQL immediately; merely launching it against the live
   database is already a migration. Validate fresh and upgrade cases on
   disposable databases first.
4. At an authorized maintenance window, quiesce the application and its agent
   companion through the verified supervisor/service. Prevent automatic restart.
   Confirm listeners/workers have stopped before taking the final consistent
   snapshot. Keep PostgreSQL running for a logical dump; do not copy live raw
   PostgreSQL files. Do not kill active research to perform an unrequested update.
5. Back up the database, matching `SETTINGS_ENCRYPTION_KEY` and `JWT_SECRET`
   or their key files, private launch configuration, and durable native-agent
   pairing/task/journal directory together. Preserve interrupted-task records:
   losing them can break duplicate-delivery/replay protection. Include configured
   update-backup storage when moving an installation. Keep a dated protected
   backup outside the release tree; never commit it or show its contents.
   Include `RESEARCH_ARTIFACT_ROOT`, document originals/import files and the
   encrypted runtime/compute/Deep Agents tables introduced by migrations53–58.
   Put the artifact root outside a replaceable release and verify its owner-bound
   size/hash manifest with the restored DB. Optional parser/E2B template/model
   versions and secrets are separate deployment dependencies; missing services
   stay explicitly unconfigured rather than falling back to an unreviewed cloud.
6. Verify the dump and restore it to a new isolated database before treating
   the backup as recoverable. Match PostgreSQL tools to the server version.
   Compare schema and selected row counts without exposing portfolio content.
   A successful dump command alone is insufficient.

With a privately configured PostgreSQL service entry (`pg_service.conf`) and
password file, logical backup commands can avoid credentials in command lines:

```powershell
$env:PGSERVICE = 'squabble-live' # Existing verified service, not a guessed target.
pg_dump --format=custom --file 'C:/private/backups/unique-release/database.dump'
if ($LASTEXITCODE -ne 0) { throw 'Database backup failed' }
pg_restore --list 'C:/private/backups/unique-release/database.dump'
# The restore service must point to a NEW isolated database.
$env:PGSERVICE = 'squabble-restore-check'
pg_restore --exit-on-error --no-owner --dbname 'service=squabble-restore-check' 'C:/private/backups/unique-release/database.dump'
if ($LASTEXITCODE -ne 0) { throw 'Restore verification failed' }
```

Create and verify both service entries/targets and the new backup directory
before adapting this example. Do not persist these temporary environment
overrides into the live launcher. Never overwrite a live database for a drill.
Raw cluster backups require a cleanly stopped database and matching PostgreSQL
major version; use the platform's supported backup procedure.

## Cut over, verify, roll back

For a source release, retain the old release and point the verified launcher to
the new root with the same private keys and durable state. Node 22 can load a
specific environment file explicitly; `npm start` does not implicitly load
`.env.local`. A foreground invocation from the new root is:

```powershell
$env:NODE_ENV = 'production'
node --env-file='C:/private/squabble.env' dist/server/main.js
```

The environment file must explicitly preserve the intended bind, auth mode,
database and state directory; inherited shell variables override its values.
For unattended use, keep the existing service/launcher and its log capture.
If a new Windows background helper is necessary, use `Start-Process` with
`-WorkingDirectory`, private logs, `-PassThru` and `-WindowStyle Hidden`.
Capture new runtime identity for this operation; do not bake it into the locator.

Verify the new process/working directory, expected loopback listener, startup
migration logs, `GET /api/health`, `GET /api/auth/mode` and loading existing
workspace/report/strategy data. Health proves app/DB readiness, not provider
connectivity or data completeness. Use read-only pages with no automatic
research trigger; opening the Today research entry can schedule work.
Do not infer read-only behavior from GET alone. In the current workspace,
`GET /api/channel` reads stored preferences and supplement status without recovery
or initialization; account selection only changes that read projection. Opening
the channel UI can still acknowledge notifications, and explicit questions/actions
write state. Application bootstrap also applies migrations and runs recovery and
background services. Use verified read-only queries or existing captured responses
for strict no-mutation inspection. Do not
start research, publish channel content, confirm a strategy, submit an order or
reconnect paid agents as an upgrade smoke test. Observe durable interrupted-task
handling without replay. Record the release and read-only verification result.

Saved daily research has two distinct recovery operations. Current-report
reformat/reconcile reuses completed source material without a model call, but can
write projection receipts. `POST /api/research-conversations/:id/resume-report`
explicitly uses AI to append the necessary full-context reverse check and summary;
it is never a deployment smoke test or automatic restart action. Within separately
authorized research, verify the original journal task is definitively terminated,
use the current expected revision and retain the same request key after a lost
response. An interrupted/dispatch-uncertain task remains blocked from replay.
Compare actual saved wire input with full frozen owner facts, retain original
findings and incomplete-input coverage, and inspect the resulting exact immutable
report version. See [research-and-execution.md](research-and-execution.md) for the
correction identity and summary-only retry contract.

If cutover fails, stop the new supervisor and preserve its logs and database
state. Restart the old release against the migrated DB only after checking
backward compatibility. If migration changes make that unsafe, restore the
matched pre-cutover DB/keys/agent-state/config backup to a separate verified
target and point the old release there. Retain both failed and original data;
do not improvise down-migrations, delete volumes or run the base schema on live
data. A restoration loses changes after the snapshot, so keep writes quiesced
until the result is accepted.

## Docker-specific update path

The standard tool suite uses a complete fixed-digest release archive; see
`deploy/README.bundle.md`. Plain root Compose in a source checkout uses local
build tags, so developers add `docker-compose.source.yml`. Never point a fresh
user at unpublished local tags as if they were public images. The old app-only
Watchtower update route is disabled when bundled capabilities are enabled.

Include `capability-secrets`, `research-artifacts` and `sandbox-state` with the
existing DB/settings/native state. Quiesce application, document and broker work
before copying the matched set; the broker owns per-job lifecycle receipts.
Worker-scoped credential volumes are regenerated from the authoritative
capability-secrets volume. Restore into an isolated project/database and verify
artifact hashes and original job/provider identities; a missing journal is not
permission to rerun a computation. Cleanup must use the original provider.

Windows source Web servers can use `deploy/compose.source-host.yml` and the
configuration export script to prepare loopback services automatically. Preserve
the original account/DB/model settings and private credential files. Desktop
installers remain paused; future macOS/arm64 qualification is separate from a
Windows Docker Desktop Linux-container test.

The source-host override uses a restricted relay with two fixed worker
destinations. Docker Desktop may retain configured bindings without actually
publishing ports for an internal-only network, so a healthy worker or Compose
configuration alone is insufficient evidence. Verify actual authenticated
loopback reachability and capability preparation while Docling and broker remain
internal-only. The relay has no keys, socket, arbitrary destination or application
state. Do not attach the engines to an Internet-enabled bridge to obtain host
access. A metadata refresh must survive cancelled MCP notification bodies as
well as return HTTP health; check process stability after the refresh.

Follow `docs/self-hosting.md` (and its Chinese counterpart). Root Compose is
`squabble-local`; demo uses a different project. Back up DB, `settings-secrets`
and `local-agents-data`, preserving any environment-supplied secrets and
`update-backups`. Stop app/companion activity for a consistent backup; the
database can stay running for `pg_dump`. `docker compose down -v` is never
an update or recovery step.

A source-image update uses the same original project/config combination:

```sh
docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.source.yml ps
```

Use reviewed code and existing volumes/config; inspect local modifications
before fetching/pulling. Managed image updates follow the installation's
update flow and image provenance. Preserve the prior digest for rollback;
the compatibility/backup rules above still apply.

Ignored `tmp/` scripts, ad hoc launchers and old chat snippets can contain
machine-specific paths, credentials or stale PIDs. Never replay them as a
deployment procedure. Read only the necessary non-secret behavior and replace
it with reviewed commands derived from the current verified instance.

## Portfolio-workspace schema compatibility

The portfolio workspace introduces migration `45_portfolio_workspace.sql` and a compatibility change to historical `42_user_strategy_runtime.sql`. Ship the complete registered migration directory and synchronized `01_schema.sql`; do not copy only migration 45. Startup replays historical files. Scoped definitions retain the old account/profile index names, and migration 42 recognizes portfolio authority so a later startup does not restore singletons or pause/cancel confirmed combinations. Backfill only maps unambiguous active published profile versions and never reactivates archived accounts.

Before an authorized release, verify a disposable fresh install, a legacy upgrade and a second complete startup after creating two independently running accounts. Read-only comparison and account selection are useful UI checks, but account detail can establish a missing baseline and application bootstrap can run migrations/schedulers. Do not describe those operations as read-only probes. A pre-workspace binary assumes owner singletons: rollback requires the matching pre-upgrade database backup or a separately validated data-compatible release, not simply launching old code over multi-account data. Preserve private data and the exact prior backup until recovery is verified.

Research deletion adds migration49, receipt storage and tombstone columns/triggers. Ship the complete synchronized migration set; startup must not clear tombstones or rebuild deleted legacy archives. Verify completed, inactive and provider-uncertain research separately before cutover; pending report revisions are also paid work. The old binary lacks deletion-aware reads and final source fences, so once records have been deleted it is not a validated rollback target over that database. Restore the matched backup into a separate database and preserve any newer state for reconciliation if rollback is necessary. Deployment smoke tests read existing reports/tasks and native readiness; test deletion only against fictional records in a disposable instance.


## Agent-roster and automatic-team additions

Migrations62–65 are additive and must be included with existing startup migrations. Back up encrypted A2A credentials/results and durable invocation identities together with existing keys/native task state. Starting a release also starts the Team run scheduler; retain existing explicit agreements and pause state, never manufacture startup authorization during deployment. Fresh installations have no such agreement. Keep the Team feature flags unchanged unless their activation is within the user's requested rollout.

Optional local A2A endpoints require `A2A_LOCAL_SERVICES_JSON` entries with exact `{id, endpoint}` URLs for both Agent Card and RPC endpoints, plus user trust. Do not reuse an MCP registry or wildcard a host. No missing external integration may silently fall back to a model or resend an uncertain task. A health/read-only deployment smoke test does not validate paid provider connectivity or structured external delivery.
