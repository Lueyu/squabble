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

## Actual offline Docling and OCR

The actual local Docling image is
`sha256:8470a752dca685a2d68f3c2741cef0a7882ebcb92ef2e5bfea31a08d87a008d7`,
**7,566,255,830 bytes** as reported by Engine. The exported model manifest contains
**103 files / 912,467,185 bytes**, SHA-256
`968d35d623d89db62c08bafd00410f3ad86956b5dd462ec983f24520c7c4796b`.
The package inventory records actual CPU Torch **2.14.1+cpu**, torchvision
**0.29.1+cpu**, RapidOCR **3.10.0**, ONNX Runtime **1.31.0** and Docling Serve
**1.38.2**. Both inventories are checked in under `workers/documents/`.

The service ran nonroot/read-only with 2 CPU / 4 GiB / 256 PIDs and bounded tmpfs,
attached only to an internal Docker network whose gateway is empty. The smoke
also verified an Internet TCP connection fails before conversion. Model hashes
are checked once at startup; health polling uses cached facts and raw process
health, without repeated weight hashing.

Initial actual execution found that bare `ocr_lang=zh-Hans` is treated as an
unsupported native engine code. The pinned API requires **`ocr_lang=iso:zh`**.
After that correction the first cold Chinese scan parsed in **13.192 s**, with
4/4 expected literals and a physical-page text locator. The targeted application
protocol spec observed RED for the old field, then **3/3 passed** after correction.

Final `deploy/document-smoke.py` run: **20/20** expected parse/reject outcomes,
**17** valid PDF/DOCX documents, **40/40** literal expected values in lossless
document text and **39/40** in Markdown, **69.243 s** total. Results are in
`workers/documents/acceptance.linux-amd64.jsonl`. The omitted Markdown value is
`Revenue 40`, classified by the engine as a page header. Its exact original text,
physical page and bounding box are preserved in lossless JSON. This distinction
must remain visible; the measurement is not an audited financial accuracy claim.
The three invalid files have explicit conversion failure results; the raw engine
probe does not test the application's separate before-upload size gate. DOCX has
element IDs and zero invented physical pages. The two-page fixture has two actual
pages. Chinese and rotated-scan fixtures all retain their expected values.

Cgroup memory peak: **2,199,445,504 bytes**; resident snapshot after the corpus:
**1.649 GiB**. This workload used no runtime model download and no model API.

## Actual Chromium component

The pinned Playwright image ran matching Chromium **158.0.8127.18**, uid1000,
`chromiumSandbox:true`, `no-new-privileges`, 256 MiB shared memory and the checked-in
upstream seccomp profile, with Internet disabled for the synthetic dynamic-HTML
probe. JavaScript rendering passed. No `SYS_ADMIN` or `--no-sandbox` was used.
An initial stricter probe added `cap-drop ALL` and hit the upstream profile's
conditional `chroot` denial; the actual app Compose configuration retains the
default bounding capability set and passes. Compute jobs retain cap-drop ALL.
Final application-image verification is still a separate pending gate.

## Remaining actual checks

Fresh whole-suite boot, final app-image Chromium, matched recovery and public
release archive verification are pending. The release workflow now cold-boots
the exact published image set with fresh disposable volumes, then runs actual
Chromium, offline document corpus, MCP and broker checks before archiving. It
stops heavier services before running the full sandbox exhaustion/recovery suite
with `SANDBOX_REAL_TESTS=1`; no skipped real suite is reported as passed.
