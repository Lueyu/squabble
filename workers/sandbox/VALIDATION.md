# Local sandbox validation record

2026-11-11, Windows source workspace. All datasets are fictional. No personal
database, model API, E2B call or paid research call is used.

- RED: `node --test workers/sandbox/broker.spec.cjs` failed3/3 because the local broker did not exist.
- GREEN: same command passed3/3 after protocol/profile/output implementation.
- RED: local adapter test failed because the local provider module did not exist.
- GREEN: local adapter tests passed3/3 including unavailable configuration, URL restrictions and durable acknowledgement before execution.
- Regression: targeted E2B/backtest/result-summary/local-adapter tests passed13/13 before adding the acknowledgement test.
- `npx tsc --noEmit --project tsconfig.node.json` passed during initial integration.
- Real engine test initially failed honestly with unavailable readiness while the analytics image was still downloading. This is not an isolation acceptance result.

Build, database and real engine acceptance are still in progress. Later evidence
must replace this line with actual results; a fake transport is not engine proof.
