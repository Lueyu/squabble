# Bundle packaging acceptance

Date: 2026-11-11. Baseline before implementation: `e18b5fe`; working branch
`codex/bundled-tools-local-sandbox`. All fixtures below are synthetic CC0 files
already under `workers/documents/fixtures`; the one financial query is public
historical data. No personal database, model call, paid cloud API or trade is
part of this record. This is an incremental record; pending checks are explicit.

## Registry and dependency preparation

- Docker Desktop Engine reports `linux/amd64`, cgroup v2, 8 CPUs and
  16,513,085,440 bytes total VM RAM.
- Anonymous GHCR manifest inspection verified Docling Serve CPU v1.38.2 amd64
  `sha256:7b31b3c2efa17534dfcffb61665b71bbc959ad309b5b7ed82c3bbdcc63cc3d58`.
  Compressed layers: 2,217,541,197 bytes. Quay v1.38.2 resolves the same amd64
  manifest. Upstream source is `9c058dbb58f61021e3a16e37edb8a7527b2cb2d4`.
- Anonymous MCR inspection verified Playwright v1.65.0 Noble amd64
  `sha256:bc4fbb329a25287ed23e9216c97063646abdd1bf2da669a9895fa3e2078b2302`.
  Compressed layers: 1,002,814,156 bytes. Both digests are fixed in Dockerfiles.
- AKTools 0.1.5 and AKShare 1.20.37 are locked with transitive hashes for Python
  3.12 Linux amd64. Actual Docker build installed 60 locked packages. Their
  software MIT notices and OCR/model notices are retained with the bundle.
- The previous Docling PyPI lock contains CUDA packages. It is explicitly not
  used as the default CPU runtime. The digest-pinned upstream CPU image retains
  its own frozen lock; build exports actual package and model SHA-256 inventories.
- One app build encountered `ECONNRESET` downloading the regional npm registry
  URLs in the existing lock. The Dockerfile now selects official npm using
  `replace-registry-host=always`, preserving package integrity hashes, with a
  cache mount and bounded download concurrency. No lock/package versions changed
  for this network repair.

## Executable deployment contracts

`node --test deploy/bundle-contract.spec.cjs deploy/release-bundle.spec.cjs`:
**4 passed, 0 failed, 0 skipped** after initial RED for missing bundle services.
Checks cover complete prepared services, persistent private artifacts, no app
Docker socket, no default published internal ports, internal-only Docling
network, nonroot Chromium/seccomp, isolated worker credentials and immutable
release image sets. Generator tests also prove app/init/analytics references are
pinned together and the independent legacy updater is removed.

`python -m unittest discover -s deploy -p test_bundle_gateway.py`:
**3 passed, 0 failed, 0 skipped**, including initial RED. Checks cover adapter-only
document routes, model corruption/missing files and the fixed financial facade.
Compose normal/source/source-host/demo configurations parse successfully.

## Actual AKTools image and query

Commands:

```text
docker build -f workers/aktools/Dockerfile -t squabble-aktools:local .
Get-Content -Raw deploy/aktools-smoke.py | docker exec -i squabble-aktools-acceptance-20261111 python -
```

Actual local image ID reported by Engine:
`sha256:52947b6f324eba45b1467f0baf587d9d95bd6f9ac041ef9067114deefc373bb3`;
size **637,190,379 bytes**. This is a local Engine image identity, not a published
registry reference. Runtime is read-only, uid1000, cap-drop ALL, no-new-privileges,
1 CPU / 768 MiB / 128 PIDs, with bounded tmpfs. Only a generated internal token
volume is mounted. Inspection found no settings key or Docker socket.

Real MCP `initialize` returned AKTools **0.1.5**; `tools/list` returned exactly the
reviewed `get_data` schema. An arbitrary function was rejected with JSON-RPC
`-32602` before upstream dispatch. The fixed `stock_zh_a_hist` operation for public
sample **600000**, 2025-01-02 through 2025-01-10, returned **7 rows of 7** with
12 original columns in **1.876 seconds** including metadata checks. Post-query
container memory snapshot: **214.9 MiB**. This is one observed public-provider
success, not an availability/coverage or financial-quality guarantee.

## Remaining actual checks

At this checkpoint: Docling image download is still completing; Chinese OCR,
twenty-fixture measurements, model inventory export, actual sandboxed container
Chromium, fresh whole-suite boot, matched recovery and public release archive
verification are pending. These are not represented as successful by fixture
or metadata checks above. Measurements will be appended after actual execution.
