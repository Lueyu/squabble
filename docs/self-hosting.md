# 🚀 Install Squabble locally

[中文](self-hosting.zh-CN.md) · [README](../README.md) · [Privacy](privacy.md)

Squabble supports two local installation paths: a standalone Windows or macOS
desktop app and a clean Docker Compose stack. There is no Squabble-operated
hosted account or sync service. Neither path requires a model key for basic
analysis, but public quotes and currency rates still require network access.
See [privacy and outbound requests](privacy.md) before adding real holdings or
provider keys.

| Path | Requirements | Where data lives |
|---|---|---|
| Desktop app | Windows x64 or macOS Intel/Apple silicon installer | Squabble application data directory on your computer |
| Docker Compose | Git and Docker with Compose | Local PostgreSQL and secrets Docker volumes |

## 🖥️ Desktop app

When a release includes desktop assets, download the installer for your system
from [Squabble Releases](https://github.com/Lueyu/squabble/releases): a Windows
x64 `.exe` installer or a macOS `.dmg` for Intel (x64) or Apple silicon
(arm64). Install and open Squabble. The desktop app starts its own local backend
and database; Docker, Node.js and Python are not required. The macOS builds
are unsigned when no signing certificate is configured, so macOS may warn or
block opening them. Check the source of any installer before choosing to open
it.

On Windows, launch Squabble normally rather than choosing **Run as administrator**.
The bundled PostgreSQL server refuses to run under an elevated administrator
process.

The Windows app checks for a stable GitHub release after startup. You can also
use **Help → Check for Updates**. Choose whether to download a new version,
then restart to install it. Squabble stops its local backend and database first
and keeps the data directory. Version 2.1.0 and earlier need one manual install
of 2.2.0 or later to gain this feature. If Windows code signing is not
configured, Windows may show an unverified publisher warning; check the
installer source.

On macOS, **Help → Check for Updates** still opens the release page for a manual
install. **TODO:** enable in-app macOS updates after Apple signing,
notarization and ZIP update artifacts are configured.

The Windows setup wizard lets you choose Simplified Chinese or English when it
opens. Extracting the bundled database and app files can make the progress bar
pause. If it remains unchanged for a long time, check whether the installer is
still writing to disk and retry after closing any running Squabble app.
Reinstalling does not automatically remove the application data directory.

On first launch, create your account and save the one-time recovery code
offline. The desktop app starts with no demo account or sample holdings. Add
holdings manually or [import a CSV](import.md). Account recovery uses the
saved code; there is no email reset service.

Automatic scans, notifications and local API integrations run only while the
desktop app is open. Quitting it stops the local backend and database. The
Docker stack can continue running after you close the browser.

The app stores its database, secrets and webview data in the operating
system's Squabble application data directory:

| System | Usual location |
|---|---|
| Windows | `%APPDATA%\Squabble` |
| macOS | `~/Library/Application Support/Squabble` |

To back up, **quit Squabble completely**, then copy the entire directory to
protected storage outside this computer. Keep the copy private: it contains
portfolio data, saved sessions and credentials or the keys needed to decrypt
them. To restore, quit the app before replacing that directory with a matching
backup; retain a copy of the current directory until you have checked the
restored installation. The desktop installation does not synchronize data with
the Docker installation or another computer.

If the app does not open, confirm you installed the build for your system,
did not launch it as administrator on Windows, and have available disk space.
A newly installed copy with an old application
data directory will use that existing data; keep a backup before replacing
the app or troubleshooting startup.

## 🐳 Docker Compose

Install [Git](https://git-scm.com/downloads/) and
[Docker with Compose](https://docs.docker.com/get-started/get-docker/). On
Windows or macOS, open Docker Desktop and wait for the engine to start. On
Linux, install Docker Engine and the Compose plugin. Check:

```sh
git --version
docker compose version
docker info
```

Then run these commands in PowerShell or Terminal:

```sh
git clone https://github.com/Lueyu/squabble.git
cd squabble
docker compose up -d
docker compose ps
```

The first start downloads the prebuilt app image from GitHub Container Registry
and may take several minutes. Open [http://localhost:3000](http://localhost:3000). The clean stack
starts with an empty database, no demo account and stable generated JWT and
settings-encryption keys. Create your account, save the one-time recovery code
offline, then add holdings or import a CSV. Registration closes automatically
after the first account is created. The app binds to `127.0.0.1:3000`
on your computer; PostgreSQL has no published host port. Check
[health](http://localhost:3000/api/health) for `{"status":"ok"}`. If the page is
not ready, run `docker compose logs --tail=100 app db`.

The root Compose project defaults to `squabble-local`. An existing
`COMPOSE_PROJECT_NAME` in your shell or `.env`, or a `-p` option, overrides that name.
Before upgrading an old demo, check `docker compose config` shows
`name: squabble-local`; if it does not, unset the override or use
`-p squabble-local` on **every** clean-stack command. Do not use `squabble`
for the clean stack, because that is the old demo project. Keep using this project
name and the same repository path for maintenance so Docker finds the existing
volumes. Do not run `docker compose down -v` to fix startup or upgrade; it
deletes data and generated keys.

| Data | Default Docker volume or container path |
|---|---|
| Accounts, holdings, reports and encrypted provider credentials | `squabble-local_dpa-data` (`/var/lib/postgresql/data` in `db`) |
| Generated JWT and settings keys | `squabble-local_settings-secrets` (`/app/.secrets` in `app`) |
| Backups made before click-to-update | `squabble-local_update-backups` (`/app/.backups` in `app`) |

The default web stack uses a prebuilt image. For an existing source installation,
run `git pull --ff-only` and `docker compose up -d` once from the same checkout
and with the same Compose project name. The database and secrets volumes remain
attached. After that, the first registered account can use **Settings →
Software updates → Update now**. Squabble saves a PostgreSQL dump and secret
files before its internal updater replaces only the app container. The database
container is left alone. The updater does not poll or install on a schedule,
and an ordinary `docker compose up -d` does not pull a newer app image.
After restarting, confirm the new version, holdings and login.

The updater needs access to the local Docker socket, which grants it permission
to manage Docker containers. It publishes no host port and uses a random token
stored in the secrets volume. Run this mode only on a trusted local machine.

Pre-update backups live in the `update-backups` volume. List them with
`docker compose exec app ls /app/.backups`, then copy one out with
`docker compose cp app:/app/.backups/<backup-directory> ./backups/`.
Keep a protected copy outside this computer. If keys are supplied through
`.env` rather than generated files, back up those values separately.

To build from source instead, use
`docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build`.
The page update button is disabled in source-build mode; pull new code and rebuild
to update. Never use `docker compose down -v` for updates or troubleshooting.

### 🎭 Optional fictional demo

To explore the sample portfolio and saved reports, run the separate demo
stack:

```sh
docker compose -f docker-compose.demo.yml up -d --build
```

Open [http://localhost:3001](http://localhost:3001) and sign in with
`demo` / `demo1234`. This stack uses a separate `squabble` Compose project and
volumes, so it does not seed the clean installation. The demo is for fictional
exploration only. Do not use its known credentials for real holdings. To stop
it, run `docker compose -f docker-compose.demo.yml stop`. Use the same `-f`
argument for later demo commands. If port 3001 is in use, set `HOST_DEMO_PORT`
in an untracked `.env` file and use the matching localhost URL.
If `COMPOSE_PROJECT_NAME` is set, clear it or add `-p squabble` to every demo
command so this stack stays separate from `squabble-local`.

**Upgrading from the earlier default demo:** the older root Compose file had
no fixed project name. A checkout named `squabble` normally used project
`squabble` and port 3000; another directory name or a Compose override may
have used a different project name. Back it up, then run `docker compose ls`
to identify its project. Before pulling the new files, stop it from the old
checkout with `docker compose down` using the same project settings. Do not
add `-v`. After pulling, the equivalent command for the common `squabble`
project is `docker compose -f docker-compose.demo.yml down`; if yours had a
different name, add `-p YOUR_OLD_PROJECT` to demo commands to reuse its old
volumes. The new clean `squabble-local` stack starts empty and does not import
those records. If you entered real data into the old demo, keep its backup and
plan any transfer separately.

### 🔄 Stop, update and back up

Run these commands from the repository folder:

| Action | Command |
|---|---|
| Stop while keeping data | `docker compose stop` |
| Start again | `docker compose up -d` |
| Check containers | `docker compose ps` |
| Read recent logs | `docker compose logs --tail=100 app db` |

Back up before upgrading. The database dump alone is insufficient to decrypt
saved provider keys; copy the generated secret files as well. These commands
work in PowerShell and macOS/Linux Terminal:

```sh
mkdir backups
docker compose exec -T db pg_dump -U postgres -d portfolio -Fc -f /tmp/squabble-backup.dump
docker compose cp db:/tmp/squabble-backup.dump ./backups/squabble-backup.dump
docker compose cp app:/app/.secrets/settings.key ./backups/settings.key
docker compose cp app:/app/.secrets/jwt.key ./backups/jwt.key
git rev-parse HEAD
```

Change the dump destination to a new dated filename on subsequent backups so
you never overwrite an earlier copy. Retain the printed Git revision and copy
the backup and keys to protected storage outside this computer. If you set
`JWT_SECRET` or `SETTINGS_ENCRYPTION_KEY` explicitly in an untracked `.env`,
back up those values instead; the corresponding file may not exist. The
`backups/` folder is ignored by Git.

To check a dump without touching the live `portfolio` database, create a
separate test database in the same container. Replace the local filename if
you used a dated one:

```sh
docker compose cp ./backups/squabble-backup.dump db:/tmp/squabble-restore.dump
docker compose exec -T db createdb -U postgres portfolio_restore_check
docker compose exec -T db pg_restore -U postgres --exit-on-error --no-owner -d portfolio_restore_check /tmp/squabble-restore.dump
docker compose exec -T db psql -U postgres -d portfolio_restore_check -c "SELECT count(*) FROM users; SELECT count(*) FROM holdings;"
```

If that test database already exists, use a new name throughout. The drill
needs extra disk space and checks the database dump, not the matching secrets
or an application cutover. Preserve the live volumes while validating a real
restore in an isolated installation.

After a backup, update with:

```sh
git pull --ff-only
docker compose up -d
docker compose ps
```

Recheck [health](http://localhost:3000/api/health), sign in and run a basic
analysis. The app applies additive SQL migrations `03` through `14` at startup
to an existing database. Fresh databases receive the base schema on first
initialization. Do not remove Docker volumes during an update. If Git reports
local changes, resolve them before pulling; if startup fails, read both app
and database logs before making another change.

### 🔧 Troubleshooting

| Symptom | Check |
|---|---|
| Docker cannot connect | Start Docker Desktop or check the Linux Docker service and permissions |
| Port 3000 is occupied | Stop the other local process or set `HOST_APP_PORT` in an untracked `.env`, then use that localhost port |
| Login page is not ready | Check `docker compose ps` and `docker compose logs --tail=100 app db` |
| Health returns 503 | Check database readiness and app logs; health checks the database, not external providers |
| Analysis fails while health works | Check the report error, quote availability and saved model connection |
| Saved provider keys cannot be decrypted | Restore the matching `settings.key` or re-enter the provider keys |
| Data appears to have vanished | Confirm the Compose project name and existing volumes before creating or removing anything |

Basic analysis can run without an AI key, but it requests public market data.
Model analysis, Finnhub research, screenshot recognition, notifications and
connected agents use their configured external services. A local installation
is not an offline model or a guarantee that no data leaves your computer.
