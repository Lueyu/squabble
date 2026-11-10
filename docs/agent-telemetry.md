# Agent telemetry · 运行分析

The `/telemetry` workspace connects operational facts, research delivery and user feedback. It uses real owner-scoped records; the Figma numbers are illustrative and are never seeded into the production UI. Opening the workspace does not launch research, retry providers, revalue accounts or execute strategies.

`/telemetry` 工作区连接运行事实、研究交付与用户反馈。生产界面只读取真实的所属用户记录，Figma 中的数字不是默认数据。浏览与刷新不发起研究、不重试供应商，也不改变账户估值或策略执行。

## Views and definitions · 页面与口径

- Overview / 综合总览: started-run cohorts, completion counts, P95 completed duration, known tokens and estimated cost coverage. Cancelled, running and unknown outcomes remain separate.
- Agents / Agent 对比: member executions and actual observed executor/model identity. A role is not a model. Missing identity, usage and acceptance stay unknown.
- Runs / 运行记录: bounded date/filter queries and pagination. A conversation can contain multiple revisions and cycles; it must not be counted as one permanent run.
- Trace / 执行详情: recorded model/native/tool operations, timestamps, retry attempts and safe failure codes. Parallel durations are not summed into wall-clock latency. Historical event projections can be truncated and are labeled accordingly.
- Quality / 效果评估: delivery acceptance, traceable evidence, reverse checks, mature adoption observations and explicit feedback use independent denominators. No metric claims investment accuracy. Fixed evaluation datasets and experiments belong to the configured Langfuse project; without it the UI explains that evaluation is unavailable.

运行完成率只针对已结束、未取消且结果明确的运行；P95 只使用可测量的已完成耗时。调用用量已结算不等于业务执行成功，交付接受不等于报告被用户采纳。预算预占不是供应商实际账单，未知 token 或价格不能显示为零。筛选和图表使用 API 返回的同一时间范围，并保留数据覆盖说明。默认范围是最近七天；趋势按 UTC 日期分桶，列表与时间选择按浏览器本地时区显示，UTC 日期标签不再次转换为本地午夜。

## Langfuse · 可选连接

The app stores metadata in PostgreSQL without requiring Langfuse. Export is **disabled by default**. Operators may configure a self-hosted or otherwise trusted Langfuse instance using server environment variables:

```dotenv
LANGFUSE_ENABLED=true
LANGFUSE_BASE_URL=http://127.0.0.1:3001
LANGFUSE_PUBLIC_KEY=pk-lf-your-project-public-key
LANGFUSE_SECRET_KEY=sk-lf-your-project-secret-key
LANGFUSE_PROJECT_URL=http://127.0.0.1:3001/project/your-project-id
```

Keep these keys outside Git and the client. The optional project URL is a navigation link, not proof that the remote service is healthy. The installed Langfuse processor version requires a compatible Langfuse deployment (SDK6 self-host guidance: version4.59 or later); use the current [Langfuse self-host documentation](https://langfuse.com/self-hosting) when provisioning the separate service. This change does not automatically create or start that infrastructure.

本地运行记录无需 Langfuse 即可使用。只有部署者明确启用并配置后，才向该地址导出元数据。项目链接不代表远端连接测试已通过。凭证仅在服务端，不能写入前端、报告或测试样本。

The exporter uses an isolated OpenTelemetry provider with the official Langfuse processor. It does not replace global application tracing or automatically serialize requests. Export contains allowlisted operation metadata, observed model identity, timing, status and known usage. Prompts, completions, portfolio contents, tool arguments, private reasoning and credentials are excluded. Export failure does not repeat a provider request or change research acceptance. Capture/export limits and missing metadata remain visible rather than turning incomplete history into a full measurement. Capture health covers the current process and resets at restart. Export readiness describes configuration, not a successful remote health probe. Known API costs are calculated once using per-reservation configured rate snapshots; no rate or unknown usage remains null, and changing rates does not reprice stored spans.

## Data ownership and lifecycle · 数据边界

All APIs derive the owner from authenticated server context. Run detail and feedback revalidate the source's visibility; deleted tasks/reports must not become readable again through telemetry. Feedback is a bounded explicit rating/comment, not an instruction or new research conclusion. Local metadata and feedback are included in normal database backups. Records already sent to an explicitly configured external Langfuse instance have their own retention/deletion lifecycle; hiding a Squabble source is not a promise of remote erasure.

所有查询、关联和反馈写入都需要所属用户范围；已删除来源不能通过运行分析重新查看。反馈是用户评审数据，不是执行授权。观测数据不会启用策略、写入真实账本或修改研究结论。外部 Langfuse 的保留与删除需由部署者管理。

## Development and verification · 开发验证

Migration52 adds operational spans and feedback; fresh schema and startup migration registration must remain aligned. Run:

```sh
npm run test:telemetry
npm run test:client
npm run test:architecture
npm run test:context
npm run check:context
npm run lint
npm run build:web
```

Set `TELEMETRY_TEST_DATABASE_URL` to an explicitly disposable PostgreSQL16 database for telemetry integration tests. A skipped database test is not integration verification. Test model/native/tool capture with fake providers and a fake exporter; never start paid research as a smoke test. Check the workspace with fictional intercepted APIs at desktop1440 and mobile390 widths, including loading, empty, failure, unknown usage, filters, pagination, feedback and deep-link return. General server/wiring checks and the three protected PR checks still apply.

## Design and interview notes · 设计与面试

The [editable Figma workspace](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=209-1040) and [architecture board](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=209-1296) distinguish existing foundations from proposed instrumentation. Discuss the actual implementation and verification separately from roadmap items. Useful engineering topics are identity across heterogeneous runtimes, accounting versus tracing, incomplete historical coverage, source deletion, human feedback and cost/quality trade-offs. Report measured improvements only after a controlled comparison with a fixed dataset and versioned evaluation rules.
