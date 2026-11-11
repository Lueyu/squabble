# Bundled Capabilities and Local Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. This user has already authorized continuous implementation, validation, PR merge and local deployment; no additional handoff choice is required.

**Goal:** 让新用户一次部署和一次授权即可使用基础工具，并以必备本地容器沙箱替代 E2B 前置条件，保留自定义工具。

**Architecture:** 能力管理负责准备事实和 owner grants，复用现有连接、数据版本、研究运行器和审批。独立受限 broker 为每个计算创建无网络 Linux 容器，应用没有 Docker socket；本地与旧 E2B 作业保留原 provider 身份。发行套件提供预装依赖/模型的固定镜像和匹配数据备份。

**Tech Stack:** NestJS/React/TypeScript、PostgreSQL16、Docker Compose/Engine、Python3.12、Docling、AKTools MCP、Playwright Chromium、QuantStats/Backtrader。

**Approved design:** [详细设计](../specs/2026-11-11-bundled-capabilities-design.md)。基线 e18b5fe；首先保存并提交本设计和计划，然后才开始生产实现。

## Task 1: local sandbox protocol and actual isolation

Files: `workers/sandbox/` (broker, Dockerfiles, tests, README), `workers/analytics/` (container entrypoint), `server/modules/research-compute/` (provider adapter/routing), `shared/research-compute.interface.ts`, additive migration after58 if provider journal required.

- [ ] Write protocol/adapter tests first: identical job id reuses receipt; changed payload conflicts; no caller image/path/mount/command; networknone, nonroot, resource limits; malformed outputs rejected; cancel/timeout/unknown/late results preserve identities.
- [ ] Run targeted Node/Python tests, capture expected RED for missing local backend.
- [ ] Implement broker create/status/output/cancel, durable identity and expiry cleanup, immutable image resolution, bounded I/O. Use argument arrays/Engine API, never shell-built code. Authentication and private address are deployment-owned. All arbitrary code remains in per-job containers.
- [ ] Add provider-aware service using current prepare/revalidate/jobs/artifacts; preserve E2B compatibility and original-provider cleanup; source egress rules distinguish local from cloud. Keep old E2B fixtures valid.
- [ ] Build actual analytics image and run network/secrets/cross-job/output/timeout/cancel/restart tests against real Docker, plus actual statistics/backtest/exploratory fixtures. Command family: `docker build -f workers/analytics/Dockerfile ...`; `node --test workers/sandbox/*.spec.cjs`; targeted `npx tsx --tsconfig tsconfig.node.json --test server/modules/research-compute/*.spec.ts`.
- [ ] Review source/usage/provider/termination fences before integration.

## Task 2: managed capability contracts and connection reconciliation

Files: `shared/tool-capabilities.interface.ts`, `server/modules/tool-capabilities/`, `server/modules/tool-connections/`, `server/modules/data-library/providers/`, new registered migration and synchronized `scripts/db/01_schema.sql`, schemas/module registration.

- [ ] Tests first for preparation vs grant, owner isolation, repeated bootstrap no duplicate AKTools, revoked remains revoked, unchanged discovery no revision/permission reset, changed catalog candidate cannot dispatch.
- [ ] Run targeted tsx tests against disposable PostgreSQL; missing implementation must fail, no skipped DB tests counted.
- [ ] Implement strict versioned pack manifest, cached readiness, owner grants and activation/revoke APIs. Default GET is read-only. Startup/saved-connection metadata verification never invokes business tools/models.
- [ ] Implement candidate/active catalog separation and current-authority revalidation; fixed AKTools facade accepts only bounded structured query fields and current explicit public-network grant.
- [ ] Preserve custom endpoints and owner secrets. Unknown MCP tools retain conservative effects; private endpoint exceptions remain deployer-owned.
- [ ] Verify state/concurrency and migrate fresh/legacy/second startup on fictional records; module boundary direction remains one-way from orchestration to capability services.

## Task 3: reproducible default bundle

Files: `Dockerfile`, `docker-compose.yml`, source/demo overrides, `workers/documents/`, `workers/sandbox/`, `deploy/`, release/CI workflow, `.env.example`.

- [ ] Add executable bundle contract checks for no app socket, no public internal ports, artifact persistence, fixed dependencies/models and model-free runtime readiness.
- [ ] Build Docling CPU with chosen OCR assets and recorded model hashes; actual sample conversion must pass disconnected from Internet. Add AKTools reviewed MCP service. Preinstall matching Chromium in supported nonroot runtime and run sandbox check.
- [ ] Wire sandbox broker, analytics image preparation, generated persistent internal credentials, exact document/MCP origins and readiness. Keep ordinary user startup one Compose command; developer build override is explicit.
- [ ] Add release manifest generation from actual image IDs/digests, anonymous pull gate, architecture-specific support record and license inventory. Do not invent published image references or successful arm64 tests.
- [ ] Run whole suite on new project/volumes, never personal DB. Record image size, cold start and actual memory. Capture OCR numerical/locator differences rather than claiming unmeasured accuracy.

## Task 4: simple capability UI and custom-tool journey

Files: `client/src/features/tool-connections/`, `client/src/api/`, `shared/tool-capabilities.interface.ts`, bilingual copy and relevant `client/src/utils/*.test.cjs`.

- [ ] UI behavior tests first: four cards show actual preparation/grant state; one-screen recommended activation; no schema/endpoint/version field in basic path; model verification still explicit charged action.
- [ ] Implement capability cards, activation summary and advanced details; preserve custom MCP/provider editor and add preset choice. Saving custom connection performs one metadata discovery; discovery result does not itself enable tools.
- [ ] Verify custom MCP discovery/approval/invocation against a real local synthetic MCP server registered only in disposable deployment; repeat discovery retains grants, changed schema requires review, revoked remains off after restart.
- [ ] Run client suite and actual browser journeys at1440/390px, Chinese/English; verify no key disclosure/overflow and recoverable failures.

## Task 5: persistence, update and knowledge

Files: `server/modules/system-update/`, `docs/agent-tooling.md`, self-hosting English/Chinese, `docs/README.md`, `docs/architecture.md`, canonical contributor references and context manifest.

- [ ] Test update backup with fictional DB/artifacts/keys, missing/corrupt artifacts and isolation. Implement matching file manifest and restore procedure; no automatic destructive volume cleanup.
- [ ] Review all five architecture flows: system/research add preparation/broker; investment application/channel publication/real ledger retain authority. Update exact changed flows and document unchanged ones.
- [ ] Update operating guides: default bundle vs source instance, local/cloud data policy, user grants, custom MCP, future Windows/macOS prerequisites and support matrix. Correct stale prior design index status.
- [ ] Run `npm run test:architecture`, `npm run test:context`, `npm run check:context`, lint and full Web build. Context mechanical success is separate from source semantic review.

## Task 6: acceptance, merge and deployment

- [ ] Run full server/client/native/dev/Python/memory suites with isolated PostgreSQL16, required sandbox/bundle tests, actual engine/browser/MCP journeys. Only advertise live upstream functionality actually exercised; do not trigger paid model/cloud calls without task-specific authorization.
- [ ] Independent spec-compliance and code-quality review; fix findings and rerun affected checks.
- [ ] Open PR with final scope and evidence, attach to task, wait required Lint & typecheck / Agent tests / Docker image build; resolve failures without weakening gates. Merge exact tested head.
- [ ] Rediscover local instance and active jobs, make matched DB/key/artifact/runtime backup, restore to separate target and verify. Deploy merged main using existing private state and new bundled services; preserve port3002 and unrelated Docker services.
- [ ] Read-only post-deploy health/settings/data checks; verify capabilities from actual local component state, no new personal paid research/trades. Update private locator/global managed skill after successful deployment.

## Acceptance evidence record

Each task records exact command, actual counts/failures/skips, current commit and fixture provenance in `docs/bundled-capabilities-validation.md` during implementation. Local Docker execution on Windows proves that host path; macOS/arm64 support remains planned until corresponding native runners execute the same contracts. A code fixture is not a live Docling/E2B/market-data certificate.
