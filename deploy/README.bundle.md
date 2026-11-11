# Bundled Web deployment

The supported runtime is Docker Linux **amd64** with Compose v2.24 or newer.
Windows uses Docker Desktop / WSL2. macOS and arm64 are future validation targets;
the current image digests deliberately do not claim native arm64 support.

## End-user release

Download the generated `squabble-bundle-linux-amd64` archive from the successful
**Bundled Web images** run for the selected commit. The archive contains exact
published image digests, anonymously checked registry manifests, schema files,
Chromium seccomp profile, notices and model/package inventory. Extract and run:

```sh
docker compose up -d
```

Open `http://127.0.0.1:3000`, create the first account, then authorize the desired
capability packs. No host Python, OCR, browser or model installation is required.
The initial image download is several GiB; document processing itself is offline.
Public webpages and financial queries require the deployment server's Internet.

The source checkout uses local image tags until a complete public archive exists.
These local tags are not a claim that new sidecars have been published. A release
is incomplete until every image digest passes anonymous registry verification.

## Source build and source Web server

Build the suite from a checkout, retaining all prepared models inside images:

```sh
docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build
```

For an existing Windows/macOS **source Web server**, start only dependencies and
export generated credentials into private files without editing endpoints:

```sh
docker compose -p squabble-tools -f docker-compose.yml -f docker-compose.source.yml -f deploy/compose.source-host.yml up -d --build
node deploy/configure-source-host.cjs squabble-tools
```

The export script preserves existing DB/model/account settings in `.env`, creates
one `.env.before-bundle` backup, writes only tool configuration and never prints
tokens. Start/restart the source Web server through the normal project workflow.
Only the source-host override publishes internal services, all on loopback.

## Isolation and persistence

The application runs as uid1000 with matching Chromium, its sandbox enabled and
the upstream Playwright seccomp profile. Browser startup never uses `--no-sandbox`
or `SYS_ADMIN`. No display/login desktop is supplied; ordinary bundle browsing is
anonymous. The existing source egress policy still filters redirects/subresources.

Docling binds its raw service to container loopback. Its authenticated gateway
allows file upload, receipt polling and result routes only. The container is on
an internal network, read-only, nonroot, with CPU/memory/PID/scratch limits. The
model manifest is verified before it becomes ready. It has no app credentials.

AKTools exposes an authenticated MCP facade with the fixed reviewed schema and
two allowed financial functions. Raw HTTP APIs, arbitrary AKShare functions and
unknown parameters are unavailable. It has no app/database credentials.

Only the trusted sandbox broker receives the Docker socket; application and
per-job containers do not. Its worker image is prepared before readiness. See
`workers/sandbox/README.md` for actual job isolation and recovery semantics.

Persistent volumes are `dpa-data`, `settings-secrets`, `capability-secrets`,
`research-artifacts`, `local-agents-data`, `sandbox-state` and `update-backups`.
Three worker credential volumes contain only a scoped copy of the corresponding
authoritative internal token; init can recreate those copies after restore.
Back up a matched database, credentials, originals/artifacts and journals. Never
use `down -v` for upgrades. The init container repairs old root-owned app volume
ownership while preserving secrets. Independent app-only Watchtower updates are
disabled by default: update the full suite using one verified release manifest.

## Verification and release

```sh
node --test deploy/bundle-contract.spec.cjs deploy/release-bundle.spec.cjs
python -m unittest discover -s deploy -p test_bundle_gateway.py
docker compose exec app node deploy/browser-smoke.cjs
```

`deploy/release-bundle.cjs actual-images.json output-directory` accepts only
complete digest-qualified image sets and checks each through an empty Docker
credential store. `.github/workflows/bundle.yml` records real pushed digests and
exports the exact model/package inventory. No version tag or digest is invented.
Measured cold boot, Chinese OCR, public query, browser and memory results are
recorded separately in the implementation acceptance notes.
