# Local per-job analytics sandbox

The Web application never receives the Docker socket. This trusted deployment
broker alone controls the local Linux container engine through fixed argument
arrays. It is a privileged deployment component, not a general Docker proxy.
The normal Compose bundle prepares it automatically; source deployments use the
same authenticated HTTP protocol on a loopback-only listener.

## Configuration

| Component | Variable | Meaning |
| --- | --- | --- |
| App | `SANDBOX_BROKER_URL` | `http://sandbox:8093` in Compose; `http://127.0.0.1:8093` for a source server |
| App | `SANDBOX_BROKER_TOKEN_FILE` | Private shared internal token file, read on each request |
| Broker | `SANDBOX_TOKEN_FILE` | Existing generated deployment token; fallback generation uses exclusive creation |
| Broker | `SANDBOX_STATE_DIR` | Private persistent journal and deployment identity directory |
| Broker | `SANDBOX_IMAGE` | Prepared analytics image reference, resolved to its immutable local image ID |
| Broker | `SANDBOX_LISTEN_HOST` | Defaults to `127.0.0.1`; Compose sets `0.0.0.0` without publishing the port |
| Broker | `SANDBOX_PORT` | Defaults to `8093` |

Never expose the broker publicly. Only loopback and the fixed Compose sandbox
service names are accepted by the app adapter. No model may select an endpoint,
image, command, mount, Docker identifier, environment variable or network mode.
No job pulls an image, installs a dependency or uses a cloud fallback.

`GET /health` returns cached metadata only. Startup and periodic checks inspect
the engine, required Linux resource controls and exact image identity; they do
not run analytics or a model. All `/v1/` operations require a deployment bearer
token. Tokens are excluded from job inputs, container environments and journals.

## Protocol and recovery

`POST /v1/jobs` accepts protocol version1, job UUID, full manifest, bounded
base64 dataset/code files and limits. It persists creation intent before
`docker create`, then returns the deterministic deployment/job receipt. Matching
content reuses that receipt; changed content conflicts. The app persists the
receipt before calling `POST /v1/jobs/:id/start`. Execution cannot be restarted.

`GET /v1/jobs/:id` reads metadata. `GET .../result` returns verified output only
after termination is confirmed. `POST .../cancel` and `.../cleanup` terminate
the original resource and never create one. A missed create acknowledgement
retains unknown status even if a single listing finds no container: an in-flight
create may still arrive. Recovery inspects only this deployment's exact names
and labels. Repeated cleanup can remove a late-arriving container. Existing E2B
receipts keep provider `e2b` and use only their original provider for cleanup.

The independent deadline sweep and broker restart cleanup destroy retained
resources. The durable journal stores identity, request hash, state and deadlines,
not dataset/code payloads. Input lives in memory until execution and in job-only
tmpfs. Results live in a bounded four-job, five-minute memory cache; a broker
restart or cache expiry can lose an unaccepted result. That job fails or becomes
unavailable and is never automatically recomputed. Durable application artifacts
remain owned by the existing private artifact service.

The fixed launcher receives one bounded stdin packet, runs the existing worker,
drains bounded logs and emits one bounded output packet before the container
exits. It does not copy tmpfs files after stopping: Docker destroys tmpfs on stop.
The broker and application independently verify output hashes and byte limits.
Every job has a read-only rootfs, nonroot UID10001, no network or host mounts,
no capabilities, no-new-privileges, default seccomp, one CPU, 2GiB RAM/no swap,
64 PIDs and bounded tmpfs. One outstanding broker job is admitted at a time.
Containers share their Linux kernel; this is not independent microVM isolation.

## Verification

```powershell
docker build -f workers/analytics/Dockerfile -t squabble-analytics:local .
node --test workers/sandbox/broker.spec.cjs
$env:SANDBOX_REAL_TESTS='1'
node --test workers/sandbox/broker.integration.spec.cjs
```

Real tests use only fictional datasets and their own temporary journal. They
exercise actual local containers, network/rootfs/socket/credential boundaries,
cross-job isolation, statistics, oversized output, timeout, cancellation and
restart cleanup. Running without `SANDBOX_REAL_TESTS=1` explicitly skips those
engine tests and does not establish actual isolation. Windows source-server
verification does not establish native macOS or arm64 support.
