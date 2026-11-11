# Local document workers

## Default prepared Web bundle

The default Web suite ships the immutable official Docling Serve CPU image
recorded in `base-image.json`, extended by this directory's `Dockerfile`. It
already contains locked Python dependencies and OCR/layout/table models; startup
does not install packages or download weights. Build records every model file's
SHA-256 and actual `pip freeze` inside `/opt/squabble`; startup verifies those
files before readiness. The default adapter selects RapidOCR Chinese (`iso:zh`)
on CPU. A private authenticated gateway exposes only the three adapter route
families; the raw API binds container loopback and has no Internet route.

Use the [bundle guide](../../deploy/README.bundle.md) for one-command release or
source builds. The older top-level requirements below document the separate
engine API matrix. **The existing PyPI-based Docling lock contains CUDA packages
and is not the default CPU image lock.** The digest-pinned official CPU image's
own frozen lock is authoritative for the shipped environment. MinerU remains
optional and is not started by the default suite.

## Separate optional engine installations

The server adapters target Docling Serve **1.38.2** and MinerU **4.2.0** on
Python **3.12.12**. Each engine needs its own virtual environment. The checked-in
top-level requirements pin the API release matrix. The checked-in
`requirements-docling-linux.lock` and `requirements-mineru-linux.lock` resolve
transitive packages with hashes for CPython3.12 on Linux x86_64/manylinux2.28;
they are not Windows or macOS locks. Install each engine separately with
`uv pip install --require-hashes -r <matching-linux.lock>` in that target
environment. Locks do not include model weights: record model file SHA-256
hashes and image digest before building a deployable image. Dependency resolution
does not prove an installed engine works. No real engine or OCR quality
acceptance has been run by the backend fixture tests.

Only the application server uploads saved, owner-checked bytes. The clients do
not expose URL-import, arbitrary filesystem paths, options, or model endpoints.
Use a private service network with explicit origin allowlists, internal API keys,
and an egress-deny policy after build-time model preparation. Local loopback
literal IPs are allowed by default; Docker DNS origins must be explicitly listed
by the operator. Requests never follow redirects or send credentials to a
different origin. Configure Docling `X-Api-Key`; MinerU requires `Authorization:
Bearer` (the `LocalDocumentHttp` auth mode must be `bearer`).

Docling startup uses `docling-serve run`, with `UVICORN_HOST=127.0.0.1`,
`UVICORN_PORT=5001`. Pre-fetch models with `docling-tools models download
--output-dir /models` at build time and archive their hash manifest. Set:

```
DOCLING_SERVE_ARTIFACTS_PATH=/models
DOCLING_SERVE_API_KEY=<internal-secret>
DOCLING_SERVE_ENABLE_REMOTE_SERVICES=false
DOCLING_SERVE_ALLOW_EXTERNAL_PLUGINS=false
DOCLING_SERVE_ENABLE_MANAGEMENT_ENDPOINTS=false
DOCLING_SERVE_MAX_FILE_SIZE=8388608
DOCLING_SERVE_MAX_NUM_PAGES=200
DOCLING_SERVE_MAX_SOURCES_PER_REQUEST=1
DOCLING_SERVE_MAX_DOCUMENT_TIMEOUT=600
DOCLING_SERVE_SINGLE_USE_RESULTS=false
DOCLING_SERVE_ENABLE_UI=false
```

The service still offers source routes: the private reverse proxy must allow
only POST `/v1/convert/file/async`, GET `/v1/status/poll/*`, and GET `/v1/result/*`
from the app network. Block `/v1/convert/source*`, cloud sources, UI, and other
routes. Resource limits should cap worker concurrency to one, memory to the
chosen host capacity, and scratch storage. Do not mount app credentials.

MinerU startup: `mineru-kit api-server --host 127.0.0.1 --port 8000 --tier
standard`. Prepare the exact tier's model files at build time and keep its
runtime/model hash manifest. Permit only the Tasks/Files/upload endpoints used
by the adapter; disable URL import at the proxy, and block service egress. There
is no automatic remote task-creation retry. A lost creation response leaves an
explicit `provider_unknown` durable job requiring settlement. Local cancellation
always prevents acceptance; MinerU additionally supports remote cancellation.
Docling's tested adapter does not claim remote cancellation support.

The app persists task IDs before polling, including late submit receipts after
local cancellation, so remote work can be reconciled without being republished.
Invoke `DocumentJobsService.runDue()`
on the scheduler; use `start`, `poll`, and `cancel` for owner-bound endpoints.
Source revision, active job, lease token, exact source version/hash, and source
availability are checked before each poll and again before version publication.
After downtime, a saved receipt can resume only while the exact source revision
and active job are unchanged; both durable lease tokens rotate before polling.
A stale worker is never allowed to publish. Three consecutive polling failures
or a thirty-minute job deadline stop acceptance; lost submissions are never replayed.

App configuration is deployer-only: `DOCUMENT_DOCLING_URL`,
`DOCUMENT_DOCLING_KEY`, `DOCUMENT_MINERU_URL`, `DOCUMENT_MINERU_KEY`, and
`DOCUMENT_ALLOWED_ORIGINS` (comma-separated exact origins for private service
DNS names). Without endpoints the originals remain saved with an explicit
unconfigured parser status. `FINANCIAL_AKTOOLS_MCP_URL` binds the reviewed
AKTools endpoint to an owner's approved MCP connection; the same endpoint must
be present in `TOOL_MCP_LOCAL_SERVICES_JSON`. Approve only the needed read tools
and public data classification. Tushare uses an encrypted owner-scoped API token
and the verified HTTPS endpoint; provider errors never expose tokens or bodies.

Every successful parse adds a library version and a private JSON artifact with
the original hash, full lossless output, markdown, element locators, and separate
numeric-validation status. No automatic truncation occurs. PDF uses physical
pages and independent printed labels. DOCX uses element IDs and never invents
pages. Unknown geometry/confidence stays unknown. Financial checks preserve
original text and record discrepancies; extraction is not audited financial data.

`generate-fixtures.py` creates twenty self-authored fixtures and `gold.json`.
Install `requirements-fixtures.txt`; supply a local CJK font path. The corpus
covers digital and scanned PDFs, rotation, signs/units, a two-page table, DOCX,
and malformed/oversized inputs. Generated files and gold are synthetic, CC0.
Gold records describe expected contents, not measured engine performance.
Real side-service acceptance must run both pinned engines on this same corpus
and report page/locator coverage, numeric agreement, failures, and latency
before enabling any document-type quality claim.

Backup `RESEARCH_ARTIFACT_ROOT` together with the database and encryption keys.
`ResearchArtifactsService.manifest(owner)` is an internal backup index and must
never be exposed as a public host-path API. The default durable per-owner quota
is 1 GiB / 10,000 artifacts, with 32 MiB per file. Restore to a private root and
verify every manifest size/hash before opening downloads. Equal content from two
owners has distinct storage paths. Bounded reconciliation collects aged `.tmp`
and unindexed orphan files after a grace period; indexed retained artifacts,
young files, unrelated owner paths, backup directories and symlink targets are
not removed merely due to age.

MinerU is used for optional document parsing. Its Apache-2.0-based license has
additional commercial thresholds and online-service attribution obligations;
retain `licenses/MinerU-LICENSE.md` and show the attribution wherever this
optional engine is deployed. Docling Serve is MIT; retain its license too.

Protocol sources: [Docling tagged usage](https://github.com/docling-project/docling-serve/blob/v1.38.2/docs/usage.md),
[MinerU Tasks API](https://opendatalab.github.io/MinerU/usage/tasks/),
[MinerU release source](https://github.com/opendatalab/MinerU/tree/57fd9d073d0b14e3b15d6d203089fc96191ca149).
