# Local sandbox validation record

2026-11-11, Windows source workspace. All datasets are fictional. No personal
database, model API, E2B call or paid research call is used.

- RED: `node --test workers/sandbox/broker.spec.cjs` failed3/3 because the local broker did not exist.
- GREEN: same command passed5/5 after protocol/profile/output implementation and canonical replay/resource-reservation coverage.
- RED: local adapter test failed because the local provider module did not exist.
- GREEN: local adapter tests passed3/3 including unavailable configuration, URL restrictions and durable acknowledgement before execution.
- Regression: targeted E2B/backtest/result-summary/local-adapter tests passed13/13 before adding the acknowledgement test.
- `npx tsc --noEmit --project tsconfig.node.json` passed after the provider and frozen replay changes.
- Real engine test initially failed honestly with unavailable readiness while the analytics image was still downloading. This is not an isolation acceptance result.

## Actual container acceptance

- `docker build -f workers/analytics/Dockerfile -t squabble-analytics:local .` passed. Local image ID/index digest: `sha256:b80d5a3b99ec58f5a04a67dedf1fefc96ecee7ada78182922aadc6e4becbeda8`; size735,653,342 bytes.
- `SANDBOX_REAL_TESTS=1 node --test workers/sandbox/broker.integration.spec.cjs` passed1/1, zero failures/skips,152.181 seconds. It exercised real security boundaries, full statistics and fixed Backtrader next-session execution, cross-job files, PID exhaustion, denied3GiB allocation under2GiB limit, symlink/oversized output rejection, timeout, cancellation and broker restart cleanup.
- The real suite exposed a succeeded-receipt/output publication race during journal fsync. Verified output is now staged before publishing success; output remains inaccessible without confirmed termination. Incorrect fictional backtest price rows were corrected to include their required per-row unadjusted basis; production validation was retained.
- A subsequent RED profile test required explicit `--pull=never`; it failed4/5 before that flag and passed5/5 afterward. This closes an image-deletion race that could otherwise ask the daemon to pull during a job.
- Current broker image built successfully with pinned Docker CLI29.9.3-r1: `sha256:b6c14c65898926c0a1cc762bedefa5626b4136f988679f0d5df6f638cec4b888`; size285,344,881 bytes.
- Current broker-container acceptance passed using generated private state/token volumes, Docker socket, no network and no published host port: `docker exec <task-broker> node /opt/squabble-sandbox/acceptance.cjs`. It verified real fixed statistics, exploratory mode, blocked public/host networking, read-only rootfs, no socket/application credentials in the job, output hashes and confirmed termination. Reported worker cgroup memory peak191,754,240 bytes. This is an observed acceptance-job peak, not a worst-case claim.
- Task containers and volumes were removed after confirmed cleanup. Failed tests now retain an unknown-resource journal instead of erasing recovery evidence.

## Durable application contracts

The earlier disposable PostgreSQL compute regressions passed12/12, and local
private-processing/missing-grant tests passed2/2. Queued replay then reproduced
a real authorization bug: retry after revoke/re-enable dispatched once under
the new grant. The service now reloads its original encrypted prepared payload
after claiming, validates frozen provider/image identity, and checks the saved
grant revision. Targeted regression passed4/4 including E2B fixture compatibility;
the image/source-policy freeze regression passed1/1 (both scenarios), with zero
dispatch after either change. The full compute suite is being rerun after these
changes; its final result will be appended below.

No native macOS/arm64 acceptance or live E2B supplier validation was performed.
The tested engine is Linux amd64 in Docker Desktop/WSL2 on a Windows source host.
