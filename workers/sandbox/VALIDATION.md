# Local sandbox validation record

2026-11-11, Windows source workspace, base commit
`90029f3465145589588fed4280da82957a690f43` plus the task working changes.
All datasets are fictional. No personal
database, model API, E2B call or paid research call is used.

- RED: `node --test workers/sandbox/broker.spec.cjs` failed 3/3 because the local broker did not exist.
- GREEN: same command passed 5/5 after protocol/profile/output implementation and canonical replay/resource-reservation coverage.
- RED: local adapter test failed because the local provider module did not exist.
- GREEN: local adapter tests passed 3/3 including unavailable configuration, URL restrictions and durable acknowledgement before execution.
- Regression: targeted E2B/backtest/result-summary/local-adapter tests passed 13/13 before adding the acknowledgement test.
- `npx tsc --noEmit --project tsconfig.node.json` passed after the provider and frozen replay changes.
- Real engine test initially failed honestly with unavailable readiness while the analytics image was still downloading. This is not an isolation acceptance result.

## Actual container acceptance

- `docker build -f workers/analytics/Dockerfile -t squabble-analytics:local .` passed. Initial local image ID/index digest: `sha256:b80d5a3b99ec58f5a04a67dedf1fefc96ecee7ada78182922aadc6e4becbeda8`; size 735,653,342 bytes.
- `SANDBOX_REAL_TESTS=1 node --test workers/sandbox/broker.integration.spec.cjs` passed 1/1, zero failures/skips, 152.181 seconds. It exercised real security boundaries, full statistics and fixed Backtrader next-session execution, cross-job files, PID exhaustion, denied 3 GiB allocation under a 2 GiB limit, symlink/oversized output rejection, timeout, cancellation and broker restart cleanup.
- The real suite exposed a succeeded-receipt/output publication race during journal fsync. Verified output is now staged before publishing success; output remains inaccessible without confirmed termination. Incorrect fictional backtest price rows were corrected to include their required per-row unadjusted basis; production validation was retained.
- A subsequent RED profile test required explicit `--pull=never`; it failed 4/5 before that flag and passed 5/5 afterward. This closes an image-deletion race that could otherwise ask the daemon to pull during a job.
- Current broker image built successfully with pinned Docker CLI 29.9.3-r1: `sha256:b6c14c65898926c0a1cc762bedefa5626b4136f988679f0d5df6f638cec4b888`; size 285,344,881 bytes.
- Broker-container acceptance passed using generated private state/token volumes, Docker socket, no network and no published host port: `docker exec <task-broker> node /opt/squabble-sandbox/acceptance.cjs`. It verified real fixed statistics, exploratory mode, blocked public/host networking, read-only rootfs, no socket/application credentials in the job, output hashes and confirmed termination. Reported worker cgroup memory peak 191,754,240 bytes. This is an observed acceptance-job peak, not a worst-case claim.
- Task containers and volumes were removed after confirmed cleanup. Failed tests now retain an unknown-resource journal instead of erasing recovery evidence.

## Durable application contracts

The earlier disposable PostgreSQL compute regressions passed 12/12, and local
private-processing/missing-grant tests passed 2/2. Queued replay then reproduced
a real authorization bug: retry after revoke/re-enable dispatched once under
the new grant. The service now reloads its original encrypted prepared payload
after claiming, validates frozen provider/image identity, and checks the saved
grant revision. Targeted regression passed 4/4 including E2B fixture compatibility;
the image/source-policy freeze regression passed 1/1 (both scenarios), with zero
dispatch after either change.

With `RESEARCH_TEST_DATABASE_URL` set to the disposable test instance,
`npx tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/research-compute/*.spec.ts`
passed 30/30, zero failures/skips, 329.436 seconds. Subsequent focused adapter
assertions were RED then GREEN (3/3) for missing deployment identity, an image
change between preparation and dispatch, and cancellation before creation with
confirmed absence and no invented sandbox ID.

uv 0.13.1 MIT/Apache copyright texts were then added from the exact upstream tag.
The notices-only analytics rebuild passed with image digest
`sha256:4594759d7ca8cc0edffa3e7d81b21f6060fe0a0d5284d0ed2490054c5abc6107`,
size 735,670,973 bytes. No worker runtime or dependency version changed.
The final broker-container acceptance passed again against that exact image,
reporting worker cgroup memory peak 191,504,384 bytes. Both upstream uv license
hashes were also verified inside the final image. Final TypeScript typecheck
passed after the focused adapter changes. No task containers or volumes remain.

No native macOS/arm64 acceptance or live E2B supplier validation was performed.
The tested engine is Linux amd64 in Docker Desktop/WSL2 on a Windows source host.
