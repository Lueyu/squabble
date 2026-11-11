# Squabble Agent 工具体系开发计划审阅稿

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 本文待用户审阅通过后执行，当前复选框均表示未来工作。

**Goal:** 让 Squabble 的 API Agent 在可追溯、可恢复、有预算与权限边界的运行层中使用既有工具及成熟外部工具，覆盖金融数据、文档、计算、搜索、浏览器和应用连接。

**Architecture:** 保留 Council 的研究顺序、报告发布和策略/账本边界；新增持久化 research-runtime、外部工具连接、数据/产物契约及外部写入确认。默认模型适配采用 AI SDK 单步调用，MCP 客户端统一外部工具接入；Deep Agents 是同边界下的可选 driver。

**Tech Stack:** 现有 React、NestJS、TypeScript、PostgreSQL/Drizzle、Zod、Playwright；官方 MCP TypeScript SDK、AI SDK；AKTools/AKShare、Tushare、Docling/MinerU；E2B 与固定 Python 分析模板；Tavily、Exa、Firecrawl、Browserbase、Composio；后续 Deep Agents/LangChain。兼容版本在 P0 验证并锁定。

**配套设计：**[总体设计](../specs/2026-11-11-agent-tooling-design.md)。代码基线 `f077b3ee4b719d043db53bb3f132e985ef32a12a`；混合部署已由用户选择。文件路径除特别说明外相对仓库根目录；标为“新增”的路径是实施目标，不表示当前已经存在。

## 1. 实施边界与里程碑

本计划不要求一次性交付所有供应商。每个阶段都有可演示结果、离线验收、真实连接验收和回退方式。没有凭据时可以完成适配器与离线测试，但不能将该供应商标记为已连通。

| 阶段 | 工作包 | 前置 | 可验收交付 | 粗估工程人日 |
|---|---|---|---|---:|
| P0 | W01 契约与依赖验证 | 审阅通过 | 锁定版本、输入输出契约、测试与fixture目录 | 2–3 |
| P1 | W02–W04 运行日志、预算、模型工具循环 | P0 | fake 模型真实多轮工具运行，可停止与恢复 | 5–8 |
| P2 | W05 连接与 MCP | P1 | 持久化连接、发现、版本启用、认证、受限调用 | 4–6 |
| P3 | W06 研究与日报集成 | P1；连接UI部分依赖P2 | 当前 API 研究和日报调用内部工具，显示真实活动 | 3–5 |
| P4 | W07–W08 产物与金融数据 | P2 | 完整数据集、AKTools/Tushare 查询和来源 | 3–5 |
| P5 | W09 文档解析 | W07 | 本地 PDF/DOCX/OCR、原页引用、解析版本 | 3–5 |
| P6 | W10–W11 计算与回测 | W07、W08 | E2B 计算、固定统计模板、受控回测和图表 | 5–8 |
| P7 | W12–W13 搜索抓取与浏览器 | P2、W07 | 多供应商路由、异步抓取、受控浏览器探索 | 4–6 |
| P8 | W14 应用连接与写入 | P2、W07 | Composio 读取、预览、确认、执行和未知状态核验 | 4–6 |
| P9 | W15 Deep Agents 后端 | P3、P6、P7 | 可选择的受控深度研究 driver | 3–5 |
| P10 | W16 完整评测与交付 | 全部 | 中英样本、端到端验证、文档、回退演练和发布包 | 3–5 |

估算合计约 39–62 工程人日，含开发、测试与评审，不是交付承诺。一个熟悉仓库的工程师串行约 8–13 个工作周；核心契约稳定后，数据/文档、计算、连接/UI 三条线可并行。供应商授权等待、基础设施准备和真实质量返工单独记录；不能按 Agent 数量机械缩短工期。

四个审阅节点：P0 后确认依赖/契约；P3 后验收工具闭环；P6/P8 后验收计算和外部写入；P10 后决定是否切换正在使用的实例。每节点都展示实际产物、已通过测试和未验证事项。

## 2. 范围覆盖矩阵

| 设计能力 | 实施工作包 | 验收/回归 |
|---|---|---|
| R01 API 工具循环 | W01–W04、W06 | A01–A07、A16 |
| R02 MCP | W05 | A08–A10 |
| R03 金融数据 | W07–W08 | A11、A12、A17 |
| R04 文档 | W07、W09 | A13、A17 |
| R05 计算/回测 | W10–W11 | A14、A15、A17 |
| R06 搜索 | W12 | A18 |
| R07 抓取 | W12 | A09、A17、A18 |
| R08 浏览器 | W13 | A09、A17、A19 |
| R09 外部应用 | W14 | A20–A22 |
| R10 来源/记忆 | W06–W11、W16 | A12、A17、A23 |
| R11 观测预算 | W02–W06、W16 | A03–A07、A24 |
| R12 Deep Agents | W15 | A25 |

## 3. 共同开发约定

- 用户批准后从重新核对的 main 建立 `codex/` 实施分支或受管理工作区，保留当前文档分支。先检查变更与基线，不把本文路径/迁移号当未来 checkout 的事实。
- 使用临时 PostgreSQL16、虚构账户、受控本地 HTTP/MCP/模型服务器和假 exporter。不得用个人实例/数据/登录状态作为破坏性测试夹具。
- 新增高影响逻辑先写有意义的失败测试，再实现，完成对应故障注入；低风险文案不增加实现镜像式测试。
- 每个工作包独立提交可评审改动；共享契约/迁移由一名集成人维护，避免并行代理各自更改同一注册表。
- 当前 `test:server` 不会自动包含所有新增嵌套目录，新增测试必须同步 package scripts 与 CI。没有数据库或侧服务的 skip 不算通过。
- 每包同步受影响文案和领域文档；结构变化同步五张架构图、仓库skill地图/测试/运维参考。当前规划文档不会使运行版本自动升级。
- 每包完成后运行针对性检查；全部完成再跑完整门禁，不在纯文档审阅阶段安装依赖、启动服务或执行迁移。

## 4. W01 契约与依赖验证

**新增：**

- `shared/agent-tooling.interface.ts`：连接、描述符、scope、结果envelope和usage。
- `shared/research-runtime.interface.ts`：run/step/invocation身份与状态。
- `shared/research-dataset.interface.ts`、`shared/research-artifact.interface.ts`、`shared/research-compute.interface.ts`：完整数据与计算契约。
- `server/modules/research-runtime/runtime-contract.spec.ts`。
- `server/modules/research-runtime/testing/fake-model.ts`、`fake-tool.ts`、`fake-clock.ts`：不访问真实服务的可控fixture。
- `docs/agent-tooling-compatibility.md`：实际兼容矩阵及版本依据。

**修改：**`package.json`、`package-lock.json`、`shared/research-tools.interface.ts`（兼容envelope和时间字段）；新增依赖后按现有脚本重新安装。实现环境仍为 Web-only。

- [ ] 建立模型/工具两轮往返、并行调用、错误schema、流式中断、usage未知、重复toolCallId的固定响应样本。
- [ ] 将设计第5节 descriptor 和第6节状态定义为共享契约；输入schema限制深度/大小，禁止外部远程 `$ref`。
- [ ] 定义旧asOf:string与新timing.observedAt/completedAt、provenance.dataAsOf:string|null的显式兼容；旧工具语义保留，新数据时间未知不填抓取时间。测试旧native消费者可读取，新金融/估值/回测不能误用外层时间通过时效验证。
- [ ] 选定并锁定 Node/TS/Zod、MCP SDK、AI SDK/provider 的兼容版本；明确只用官方MCP client承接连接，不同时启动AI SDK的第二套MCP连接。
- [ ] 以fake HTTP证明模型adapter每次step只发一次请求，关闭自动retry、fallback、JSON修复付费调用和自动多step。
- [ ] 核对 Docling/MinerU/Python/E2B/QuantStats/Deep Agents 的模块格式、Python版本、部署依赖与开源许可证，记录供应商官方来源；不开真实账号。
- [ ] 运行以下测试，预期schema非法/身份冲突被拒绝，合法fixture序列化往返一致；记录真实失败，不用catch将其伪装成功。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/research-runtime/runtime-contract.spec.ts
npm run type:check
```

**验收产物：**审阅后的契约、锁文件和兼容记录；不能只交一个所有版本为 latest 的安装列表。

## 5. W02 持久化运行日志与迁移

**新增：**

- `server/database/agent-tooling.schema.ts`。
- `scripts/db/53_agent_tool_runtime.sql`（执行前核对编号）。
- `server/modules/research-runtime/runtime-journal.service.ts`、`runtime-journal.rules.ts`、`runtime-journal.integration.spec.ts`。
- `server/modules/research-runtime/runtime-recovery.service.ts`、`runtime-recovery.integration.spec.ts`。

**修改：**`server/common/platform/database.provider.ts`、`scripts/db/01_schema.sql`、`server/modules/experience/migration-packaging.spec.ts`、`package.json`。

run的唯一身份固定为：

```ts
export interface RuntimeIdentity {
  owner: string;
  sessionId: string;
  cycleId: string;
  revision: number;
  memberId: string;
  turn: number;
  executionAttempt: number;
}
```

- [ ] 先加入A01/A02/A05/A06的失败测试：两worker领取同step、同key改参、派发前后崩溃、响应保存后解析失败、停止后的迟到结果。
- [ ] 建立run、step、invocation、连接/catalog等增量表与owner唯一约束；opening可关联memberAttempt，后续turn不复用缺少turn维度的旧唯一键。
- [ ] 实现事务领取、leaseToken、heartbeat、cursor、完整响应先保存后解析；旧run不自动迁移成新driver。
- [ ] P1先把有界私有请求/响应和小工具结果存数据库，明确大小上限和inline存储版本；超限在dispatch前拒绝，不依赖W07 artifact服务。W07增加引用式存储时保持旧receipt可读。
- [ ] 恢复只读取receipt或查询已支持的远端job；未知同步模型请求不自动重发。明确“本地返回已存”“本地解析失败”“远端结果未知”的不同动作。
- [ ] 增量迁移从空库、当前schema升级、第二次完整启动各验证一遍；迁移不得调度研究、创建预算或修改账户余额。
- [ ] 执行测试并将新模块测试加入`test:server`；提交迁移及其测试为同一变更。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/research-runtime/runtime-journal.integration.spec.ts server/modules/research-runtime/runtime-recovery.integration.spec.ts server/modules/experience/migration-packaging.spec.ts
```

**前置：**`RESEARCH_TEST_DATABASE_URL` 与 `COUNCIL_TEST_DATABASE_URL` 指向明确的临时库。预期所有用例执行，无数据库时直接失败并说明前置条件。

## 6. W03 预算、调用次数和费用结算

**新增：**`server/modules/research-runtime/runtime-dispatch.service.ts`、`runtime-dispatch.integration.spec.ts`；`server/modules/tool-connections/tool-budget.service.ts`、`tool-budget.integration.spec.ts`、`tool-connections.module.ts`（先提供预算，W05扩充连接能力）。

**修改：**`server/modules/llm-budget/llm-budget.service.ts`、`llm-budget.rules.ts`、`server/database/llm-budget.schema.ts`、`server/modules/paper-trading/automatic-research-budget.service.ts`、`server/modules/council/council.service.ts`、迁移53。

- [ ] 写A03/A04/A07：3个模型step对应3个dispatchKey、每类次数计数各增加3，重复恢复不增加；SDK内部500/429不能隐式重发。
- [ ] 给新模型reserve加入owner+dispatchKey幂等；同key不同requestHash返回冲突，旧记录保留原逻辑。
- [ ] 新路径将token预算、自动调用次数和会话次数纳入统一可恢复派发事务；移除新路径旧turn外层重复计数。
- [ ] 派发协调器通过中立预算接口使用已有自动研究预算，不能为复用一个service导入整个paper-trading模块形成依赖环；在wiring和静态边界中覆盖该连接。
- [ ] token预估覆盖工具schema、toolCalls、toolResults和历史消息；原子冻结持仓/现金不可通过静默裁剪让请求适配预算。
- [ ] 新增工具额度预留与实际用量结算；DeepSeek已有task/day计数仅由一个入口负责，避免adapter内外重复reserve。
- [ ] 区分供应商强制上限、本地估算和操作额度；无可靠金额上界时只能使用用户已授权的次数/页数/秒数预算并显示金额未知，严格金额上限任务拒绝该连接。测试远端取消延迟，不能承诺本地阈值保证无超支。
- [ ] 实现unknown后续usage修正账、已知币种和价格快照；重复回调不重结算，未知不计零，不静默修改用户默认额度。
- [ ] 加预算不足的启动前检查及结束输出预留；验证额度耗尽时保存阶段结果并说明尚未完成的步骤。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/research-runtime/runtime-dispatch.integration.spec.ts server/modules/tool-connections/tool-budget.integration.spec.ts server/modules/settings/llm-budget.integration.spec.ts server/modules/settings/llm-budget-http.spec.ts
```

**前置：**`BUDGET_TEST_DATABASE_URL`、`COUNCIL_TEST_DATABASE_URL`。**完成条件：**实际HTTP次数、dispatch receipt、三类限制计数一致；中断不导致重复收费或无依据退款。

## 7. W04 模型单步适配和内部工具循环

**新增：**

- `server/modules/research-core/model-step.interface.ts`、`model-step.service.ts`、`ai-sdk-model.adapter.ts`、`model-step.spec.ts`。
- `server/modules/research-runtime/research-runtime.module.ts`、`research-runtime.service.ts`、`runtime-loop.spec.ts`、`runtime-limits.ts`。

**修改：**`server/modules/research-core/research-core.module.ts`、`server/modules/research-tools/research-tools.service.ts`、`research-tools.registry.ts`、`research-tools.output.ts`；`scripts/module-boundaries.spec.cjs`与对应ESLint边界。

单步输出以以下语义实现，不混入自动tool.execute：

```ts
export interface ModelStepResult {
  text: string;
  toolCalls: Array<{ id: string; toolId: string; arguments: unknown }>;
  finishReason: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  providerRequestId: string | null;
}
```

- [ ] 用fake模型实现预期序列：第一轮get_quotes，第二轮get_financials，第三轮最终交付；测试每轮工具结果确实进入下一模型请求。
- [ ] 实现模型singleStep，通过W03派发边界；旧chatFast/Slow和JSON调用保持兼容。
- [ ] 使用现有ResearchToolsService执行业务工具，封装权限/版本校验、真实活动与持久化结果；内部工具不复制业务实现。
- [ ] 实现同一run单模型请求、只读工具最多2并发、单连接最多1在途；停止/租约失效立即禁止后续dispatch。
- [ ] 最多step/tool上限与用户预算取最小值，防止重复工具循环；只有相同toolCallId的重放复用receipt，不把用户新请求仅因参数相同错误去重。
- [ ] 加文本型/不支持工具模型的明确能力状态；付费探测使用显式POST和无副作用echo工具，GET仅返回缓存。
- [ ] 执行A01–A07，确认research-core没有反向导入research-tools/runtime，Nest wiring通过。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/research-core/model-step.spec.ts server/modules/research-runtime/runtime-loop.spec.ts
npm run test:architecture
npm run test:wiring
```

## 8. W05 工具连接与 MCP Client

**扩展目录：**`server/modules/tool-connections/`。修改W03已建的`tool-connections.module.ts`，新增`tool-connections.controller.ts`、`tool-connections.service.ts`、`tool-catalog.service.ts`、`mcp-client.adapter.ts`、`tool-transport-policy.ts`、`tool-oauth.service.ts`、`tool-connections.integration.spec.ts`、`mcp-contract.spec.ts`、`tool-transport.spec.ts`。

**新增前端：**`client/src/api/tool-connections.ts`、`client/src/features/tool-connections/ToolConnectionsPanel.tsx`、`ToolConnectionEditor.tsx`、`ToolCatalogReview.tsx`。

**修改：**`server/app.module.ts`、`client/src/pages/Settings/SettingsPage.tsx`、`SettingsNavigation.tsx`、`client/src/features/navigation/workspace-navigation.ts`、中英文i18n。

- [ ] 建立fake MCP server，覆盖list/call、schema变化、重名、超大输出、认证到期、listChanged、取消和发送后断线。
- [ ] 实现连接配置加密与无密钥DTO；通用公网HTTP和部署者登记的本地侧服务分开处理。
- [ ] 发现生成候选catalog，用户启用精确工具版本；新工具不热注入既有run，不把远端readOnly hint作为权限证明。
- [ ] 官方MCP client使用受控网络transport；校验DNS/socket目标、重定向、认证host、schema大小，禁止远程ref、任意stdio命令及通用浏览器tools/call代理。
- [ ] 实现OAuth state/PKCE/固定callback/owner绑定、过期与重放拒绝；授权成功在后端验证，不以callback页面打开作为证据。
- [ ] 完成连接页、catalog差异确认、断开、配置状态与最后验证时间；现有`/settings/mcp`保持对外方向并提供导航。
- [ ] 探测划分配置检查、网络/认证发现和付费执行样本；只有纯本地配置检查保证不产生供应商费用，其余显示已知或未知计费属性。
- [ ] 通过A08–A10和跨owner测试，再加入一个无副作用测试MCP完成实际协议往返；真实外部MCP另记验收。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/tool-connections/*.spec.ts
npm run test:client
npm run test:wiring
```

## 9. W06 接入当前研究室和日报

**修改：**`server/modules/council/council.service.ts`、`simple-council.service.ts`、`simple-council.controller.ts`、`council-recovery.service.ts`、`council.module.ts`、`server/modules/experience/daily-workspace-research.service.ts`、`server/modules/research-tools/research-tools.service.ts`、`shared/simple-conversation.interface.ts`、`shared/research-execution.interface.ts`。

**新增：**`server/modules/council/council-api-tools.integration.spec.ts`、`council-api-tools-daily.integration.spec.ts`、`server/modules/research-runtime/runtime-read.controller.ts`（只读run详情，复验owner及原会话/任务可见性）；`client/src/features/research-workspace/ResearchToolActivity.tsx`、`ResearchToolPolicy.tsx`、`client/src/utils/research-tool-runtime.test.cjs`。

- [ ] 写单股和PORTFOLIO两种失败用例，组合明确查询冻结证券清单，拒绝清单外instrument与其他账户。
- [ ] 给新建run冻结driver和工具能力，当前API路径调用运行器；旧任务/native路径固定原实现，不因升级被自动重跑。
- [ ] 替换“简化入口一律webResearch=false”的硬限制为显式能力策略；默认未授权网页能力仍不可用，不全局放开。
- [ ] 保留独立提交屏障、reverse-check和summary，验证完整持仓与现金进入每个必要请求；观点不跨未解封成员泄漏。
- [ ] 运行结束按run/attempt重读本成员新增证据，加冻结共同证据后执行parseContribution；相同集合传入MemberOutput.sources和独立提交，响应保存时固定该集合供reparse使用。测试两个成员各自新evidence ID引用成功、互引失败、解封后报告仍能解析引用。
- [ ] API recovery增加本地receipt/reparse分支与兼容的runtimeTarget:{runId,stepId?,expectedCursor}；请求hash和验权包含目标，旧payload走legacy。测试opening已成功而后续summary失败时只恢复该目标step，旧cursor返回冲突；普通Chat Completions不展示不存在的远端查回能力。
- [ ] 活动UI只显示真实step/tool事件，正确标记部分成功、取消待核实、未知、预算耗尽与来源失效；历史查看不触发研究。
- [ ] 检查`/daily`生成、停止、恢复与报告历史，不新增策略启用、频道无依据发布或账本变更。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/council/council-api-tools.integration.spec.ts server/modules/council/council-api-tools-daily.integration.spec.ts server/modules/council/council.owner-context.spec.ts server/modules/council/council-stop.integration.spec.ts server/modules/council/council-report-resume.integration.spec.ts
node --test client/src/utils/research-tool-runtime.test.cjs
```

**阶段评审：**用虚构账户演示一次单股研究、一次全组合日报、一次中断恢复，证明模型真实用工具且无需用户逐次点击读取工具。

## 10. W07 数据集与产物基础

**新增：**`server/modules/research-artifacts/`的module/service/controller/storage/rules及测试；`server/modules/data-library/data-dataset.service.ts`、`data-dataset.rules.ts`、`data-dataset.integration.spec.ts`；`scripts/db/54_research_artifacts.sql`；`server/database/research-artifacts.schema.ts`。

**修改：**`server/database/data-library.schema.ts`、`server/database/data-library-visibility.ts`、`shared/data-library.interface.ts`、`data-library.service.ts`、`research-tools.evidence.ts`、`research-tools.output.ts`、`research-tools.service.ts`和迁移注册/fresh schema。

- [ ] 写1000+行数据fixture：模型preview为12行，但dataset完整行数与计算输入hash不变；分页中断必须partial。
- [ ] 扩充现有source/version的dataset类型；dataset metadata附属于现有精确版本，禁止建立不受墓碑约束的平行来源系统。
- [ ] 实现私有artifact存储、hash校验、owner下载、MIME/大小/数量限制、原子提交和未引用临时文件回收。
- [ ] 统一libraryReferences投影到所有外部/数据/计算工具，修复只对少数工具特判的证据元数据路径。
- [ ] 来源停用/删除、job lease失效或当前授权修订时中断新使用，最终提交再复验；单纯创建v2不撤销仍有效的不可变v1引用。若政策明确撤销旧版，记录独立revoke状态；迟到产物不恢复被删/撤销版本。
- [ ] 产物继承输入来源最严格的数据分类、保留和外发限制；测试持仓图表、私密文档摘要、公开+私密混合数据不会被自动标为public，并在发送E2B/Composio前再验证。
- [ ] 保护原有不可变报告与成交快照；来源删除后新检索/下载受限，历史引用显示不可用，不重新拉取补回。
- [ ] 加本地artifact备份/恢复清单与配额；两owner相同hash内容不能通过存储去重越权。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/research-artifacts/*.spec.ts server/modules/data-library/data-dataset.integration.spec.ts server/modules/research-tools/research-tools.integration.spec.ts
npm run test:memory-eval
```

## 11. W08 AKTools、Tushare与金融正规化

**新增：**`server/modules/data-library/providers/financial-provider.interface.ts`、`financial-provider.registry.ts`、`aktools.provider.ts`、`tushare.provider.ts`、`financial-normalization.ts`、`financial-providers.spec.ts`；`financial-dataset.integration.spec.ts`。

**修改：**`data-financial.service.ts`、`research-tools.registry.ts`、`server/modules/research-core/financial-evidence-metadata.ts`、`client/src/features/data-library/FinancialSources.tsx`；新增数据集预览组件。

- [ ] 建立A/H/US财报与行情fixture，覆盖同名代码、单位、币种、合并口径、YTD/季度/TTM、公告/更正日期、复权、空表与权限不足。
- [ ] 保留DataFinancialService facade，提取provider adapter与能力目录；金融接口调用经固定白名单映射，不开放任意AKShare函数/Tushare接口名称。
- [ ] AKTools复用MCP发现/参数/数据能力；Tushare走官方HTTP；抓完整分页后通过W07提交数据版本。
- [ ] 统一记录row级时点、source、accountingBasis和availableAt依据，不把现有US-GAAP默认套给A/H，也不把抓取时间填为公告时间。
- [ ] 增加完整历史交易日历数据能力；现有仅2026年日历不可用于任意年份回测，缺覆盖时失败并说明。
- [ ] UI显示每连接实际市场/操作/权限/延时/覆盖；禁用连接不等于删除历史数据，数据保留与外发规则单独检查。
- [ ] 用fake provider通过A11/A12，再按预算对每个已授权真实provider执行一条明确样本，记录来源/时间/行数而非只记录HTTP200。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/data-library/providers/financial-providers.spec.ts server/modules/data-library/financial-dataset.integration.spec.ts server/modules/data-library/data-financial.integration.spec.ts
```

## 12. W09 本地文档解析

**新增：**`server/modules/data-library/documents/docling-client.ts`、`mineru-client.ts`、`document-provenance.ts`、`document-validation.ts`及同名spec；`document-jobs.integration.spec.ts`；`workers/documents/`部署锁文件、说明及合成文档fixtures；`client/src/features/data-library/DocumentPagePreview.tsx`、`DocumentExtractionStatus.tsx`。

**修改：**`data-library.extract.ts`、`data-library.service.ts`、`data-library.requests.ts`、`shared/data-library.interface.ts`；部署compose配置及文档。

- [ ] 先建立20份有许可或自制样本及人工金标，包含中文扫描、英文数字PDF、旋转页、负号/括号、万元、跨页表、DOCX、加密/损坏/超限文件。
- [ ] Docling固定版本模型在构建期准备；服务仅接服务端上传文件，关闭从任意URL下载，配置内部鉴权和资源上限。
- [ ] 长解析走既有job/lease异步路径，接入取消和最终版本复验；上传HTTP不等待全部OCR，也不默默截断全文。
- [ ] 保存原件hash、lossless JSON、索引文本和按需页图；PDF页引用包含physicalPage、pageLabel、elementId、bbox方向和原页尺寸，未知坐标保持空。DOCX使用paragraph/table/cell的稳定elementId；仅固定渲染器产生并归档的派生PDF提供页码，记录渲染版本。
- [ ] 解析状态与数字核对状态分开；检查单位、负号、年份、跨页表头和合计，原文与差异都保留，不能自动改写金额。
- [ ] 用同样契约接MinerU并比较样本；两引擎均支持显式重解析产生新版本，选择默认引擎依据记录而非品牌印象。
- [ ] 验证来源删除、服务超时、重试、崩溃回调和产物清理；达到A13金标门槛后才标记支持对应文档类型。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/data-library/documents/*.spec.ts server/modules/data-library/document-jobs.integration.spec.ts
```

**真实侧服务验收：**使用已固定的本地Docling和MinerU镜像，运行同一fixture集合；常规CI可先跑fake adapter，另设明确的离线侧服务job，不把缺侧服务skip算作解析通过。

## 13. W10 E2B计算和QuantStats

**新增：**`server/modules/research-compute/research-compute.module.ts`、`research-compute.service.ts`、`e2b.adapter.ts`、`compute-jobs.service.ts`、`compute-policy.ts`、`compute.integration.spec.ts`；`workers/analytics/pyproject.toml`、`uv.lock`、`squabble_analytics/manifest.py`、`statistics.py`、`charts.py`、`tests/test_statistics.py`、`tests/test_manifest.py`。

**修改：**research-tools注册/服务/模块、artifact job关联、研究室和报告reader的产物显示、预算与telemetry metadata。

- [ ] fake E2B覆盖创建前失败、创建后超时、执行未知、下载失败、取消未确认和资源遗留；不得重复创建收费sandbox。
- [ ] 固定Python/pandas/NumPy/QuantStats/绘图库/字体；关闭默认外网与公共访问，任何所需网络目标单独授权。
- [ ] 输入manifest由服务端生成，完整dataset版本与hash上传；不注入生产数据库、模型、应用、浏览器凭据。
- [ ] 固定模板实现收益频率、基准、无风险利率、Sharpe/Sortino、波动率、回撤等统计，缺值保留；QuantStats胜率显示为正收益期间占比。
- [ ] 自由代码标记exploratory；成功退出不自动标为经核验计算。保存代码hash、seed、依赖与输入manifest。
- [ ] 下载并验证图表和表格，提交本地artifact后销毁sandbox；没有持久化完成不能返回“报告产物已保存”。
- [ ] 通过A14/A17/A24；真实E2B仅用虚构dataset限额运行一次，计入账本，证明断网配置、产物下载和资源销毁。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/research-compute/*.spec.ts
uv run --project workers/analytics pytest workers/analytics/tests/test_statistics.py workers/analytics/tests/test_manifest.py -q
```

## 14. W11 受控历史回测

**新增：**`workers/analytics/squabble_analytics/backtest.py`、`market_rules.py`、`point_in_time.py`、`tests/test_backtest.py`、`tests/test_point_in_time.py`；`server/modules/research-compute/backtest-contract.ts`、`backtest-contract.spec.ts`。

**设计选择：**复用成熟回测引擎的事件、订单和分析接口，不自写一套通用撮合系统。P0以Backtrader做兼容/许可证验证，W11只在通过后使用其固定版本；未通过时先提交引擎替换决策供审阅，不能偷偷删去回测范围或宣称QuantStats统计即回测。实际市场约束由Squabble薄适配与fixture定义，关闭引擎的提前成交选项。

- [ ] 建立10个可手算情景：下一交易日成交、公告日前不可用、拆股分红、停牌、涨跌停、费用、FX、入金、缺失年份日历、退市股票池。
- [ ] 实现schema化回测请求：证券池/版本、区间、数据availableAt、信号频率、成交规则、费用/滑点、基准、现金流和seed；缺关键输入时拒绝validated模式。
- [ ] 首版validated只执行审查过的固定策略模板+参数，完整数据由可信引擎读取并逐时点传给模板，关闭提前成交选项；模型自定义Python不进入validated执行器，保持exploratory。未来支持自定义validated策略需单独的数据代理/进程隔离设计，不能依赖同进程封装隐藏全表。
- [ ] 市场规则带有效日期和日历版本；不能用2026日历推断全部历史，也不能把缺失行情前填成可成交价格。
- [ ] 固定并记录Backtrader的preload/runonce/提前成交相关配置；增加固定股数跨拆股分红、现金到账、费用与可卖数量金标。市场有效期内T+1等结算规则缺失时拒绝validated，而非采用零约束。
- [ ] 订单级撮合只用不复权可成交价与独立公司行动，不用总回报/前后复权价套入现金、整手、涨跌停/成交量规则；复权序列仅用于收益分析/基准且不重复加分红。费用、税费、换汇和现金流进入可审计流水。
- [ ] 输出假设回测净值、交易记录、覆盖、样本外区间和统计，明确与实际NAV/模拟盘区分；不写入真实或模拟订单。
- [ ] 通过A15；对于无历史成分/退市数据的股票池保留current-universe标签，禁止宣称完整无幸存者偏差。

```powershell
uv run --project workers/analytics pytest workers/analytics/tests/test_backtest.py workers/analytics/tests/test_point_in_time.py -q
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/research-compute/backtest-contract.spec.ts
```

## 15. W12 搜索与Firecrawl

**新增：**`server/modules/tool-connections/providers/tavily.adapter.ts`、`exa.adapter.ts`、`firecrawl.adapter.ts`、`search-provider.contract.ts`、`search-providers.spec.ts`、`crawl-jobs.integration.spec.ts`。

**修改：**`server/modules/research-core/research-web.service.ts`仅提取兼容入口；registry和budget接入；资料库source/job/version用于持久化结果。

- [ ] 固定查询、top-k、语言、时间窗、域名和最大成本契约；保留DeepSeek为基线。
- [ ] 每provider实现一种主接法，通用MCP接法使用同连接身份，不重复发现/双重计费；工具返回实际来源与获取时间。
- [ ] Firecrawl长crawl存远端jobId、页数/深度/域名/credit限额；取消后查状态，无法确认停止时保留未知。
- [ ] 正文下载进入现有版本与来源复验；搜索日期未知不能补为精确公告日期，转载不可当原始披露。
- [ ] fallback是可见的独立调用，预算重新检查；已发送的收费搜索超时不自动三家重试。
- [ ] 跑A18统一样本，中文英文分别记录质量、来源命中、成本和时延；依据结果确定默认连接，不预先宣称某家更好。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/tool-connections/providers/search-providers.spec.ts server/modules/tool-connections/providers/crawl-jobs.integration.spec.ts
```

## 16. W13 浏览器探索及托管适配

**新增：**`server/modules/data-library/browser/browser-research-session.ts`、`browser-navigation-policy.ts`、`browser-mcp.adapter.ts`、`browserbase.adapter.ts`及对应spec。

**修改：**现有`browser-source.runtime.ts`、`data-browser.service.ts`、`research-tools.registry.ts`、浏览器连接UI与说明；原read_browser_source保持兼容。

- [ ] 保留已保存来源读取路径，先证明原登录、加密状态、固定出口和提交租约测试仍通过。
- [ ] 新增run级临时上下文，默认无登录态；允许只读导航/翻页/展开/截图，不暴露任意JS、宿主机文件或shell。
- [ ] 登录绑定已拥有的来源连接，人工登录不占同步租约；表单提交/会改变账号状态的动作进入写审批。
- [ ] Playwright MCP只导入受控工具子集，禁用会绕过当前网络/执行策略的能力；Browserbase映射相同会话接口但不自动复制本地cookie。
- [ ] 核对云浏览器导航、重定向、子资源、下载实际发生的位置及策略；对Browserbase执行已授权的限额真实验证。仅校验Nest到Browserbase API不算出口验证，不满足网络策略的云后端保持禁用/未验证。
- [ ] 下载统一通过artifact校验，防跨owner、路径逃逸、无限标签页、页面数和内存泄漏；超时/重启回收会话。
- [ ] 在虚构站点通过A19：登录过期、导航重定向、恶意网页指令、私网目标、取消、来源删除和迟到采集。

```powershell
npm run test:browser
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/data-library/data-browser.integration.spec.ts server/modules/research-tools/research-browser.integration.spec.ts
```

## 17. W14 Composio与外部写入确认

**新增：**`server/modules/tool-connections/providers/composio.adapter.ts`、`composio-auth.spec.ts`；`server/modules/tool-actions/`的module/controller/service/rules及integration tests；`scripts/db/55_tool_actions.sql`；`client/src/features/research-workspace/ToolActionPreview.tsx`、`ToolActionReceipt.tsx`。

- [ ] fake Composio覆盖connected-account归属、授权过期、callback伪造、请求已执行但响应丢失、目标资源版本冲突。
- [ ] 实现用户级session及连接授权，禁用workbench/bash及无法枚举具体行为的批量工具；读取和写入分开白名单。
- [ ] 先交付Drive/Notion读取、研究笔记和邮件草稿；草拟不对外写入。
- [ ] 实现15分钟预览、完整正文/差异与目标/附件展示；hash覆盖账号、payload、工具catalog、来源、连接修订和费用上限。
- [ ] 确认时事务领取唯一执行权，最终再次复验；重复点击返回原receipt，改正文/收件人/附件必须重新预览。
- [ ] 远端不支持幂等时保留unknown，停止自动重试；通过日志或目标应用核实，有据才能结算为成功/失败。
- [ ] 拒绝无交互客户端的写入，保留草稿；当前研究API不能借外部连接取得模拟下单/真实交易权限。
- [ ] 通过A20–A22；真实写入验收使用用户指定测试账号/资源，审批卡展示具体目标后才执行，不使用个人收件人做默认测试。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/tool-actions/*.spec.ts server/modules/tool-connections/providers/composio-auth.spec.ts
npm run test:client
```

## 18. W15 Deep Agents后端

**新增：**`server/modules/research-runtime/drivers/runtime-driver.interface.ts`、`deep-agents.driver.ts`、`deep-agents-policy.ts`、`deep-agents-driver.spec.ts`；对应模型适配测试与文档。

- [ ] 将默认runtime暴露为统一driver契约，Council对driver只认受控交付、活动和恢复状态。
- [ ] Deep Agents使用经核验的LangChain模型接口；不得把AI SDK LanguageModel当兼容对象强行断言。
- [ ] 每个模型/工具请求都经过同一dispatch/预算/来源入口，关闭隐藏重试和无约束子代理；同run只存在一个循环所有者。
- [ ] 子任务固定parentRunId、权限子集、预算分配和小于父任务的限制；只给临时文件上下文，不能取得本地宿主目录或全局memory写权限。
- [ ] 冻结持仓/现金和必需来源不被框架自动摘要丢失；独立观点不通过共享文件跨成员泄漏。
- [ ] 先以只读研究模式通过A25，再按共同工具审批能力扩展；不支持预算前置拦截或恢复契约的版本不能启用该driver。
- [ ] 对相同样本比较默认driver与Deep Agents的质量、实际调用数、失败恢复、耗时和成本，记录选择建议而非只展示成功案例。

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/research-runtime/drivers/deep-agents-driver.spec.ts
npm run test:architecture
npm run test:wiring
```

## 19. W16 评测、观测、文档和交付

**新增：**`scripts/evaluate-agent-tools.cjs`、`fixtures/agent-tools/`公开/自制样本与金标、`docs/agent-tooling-validation.md`、`docs/agent-tooling-operations.md`。

**修改：**`server/modules/telemetry/`读取新run/step/tool/action元数据，`client/src/features/telemetry/`；`docs/architecture.md`、`docs/research-data-workspace.md`、`docs/browser-source-collection.md`、`docs/agent-telemetry.md`、中英文自托管说明；仓库contributor skill参考与context manifest；CI配置。

- [ ] 完成A01–A25逐项证据表，区分离线fake、真实本地侧服务、真实云服务和人工UI检查；未运行项明确阻断对应能力上线。
- [ ] 运行中英搜索、文档金标、金融字段与计算参考集，锁定dataset/query/provider/config版本；评估输出不能包含真实私有资料。
- [ ] 遥测关联step/工具/子run但不改变业务结果；出口故障不重发研究，未知成本不显示0，删除来源不透过trace恢复内容。
- [ ] 实际浏览器验收1440px/390px，完整跑连接、授权、研究、停止恢复、PDF引用、图表下载、写预览、重复确认、断线与历史返回。
- [ ] 验证增量升级、二次启动、关闭各能力开关、保留在途unknown、旧报告和旧native任务兼容；演练临时环境的DB/密钥/artifact匹配恢复。
- [ ] 跑完整门禁，修复评审发现；通过PR进入main，保持保护规则，生产切换按用户当时明确授权单独执行。
- [ ] 合并后按既有授权范围同步contributor skill，记录代码版本、已启用连接、版本锁、测试证据和实际限制。

## 20. 验收用例清单

| ID | 输入/故障 | 必须观察到的结果 |
|---|---|---|
| A01 | 模型提出两轮工具，再给最终回答 | 每轮有实际receipt，结果进入下一轮，最终引用可打开 |
| A02 | 同key重试或同key改参、两个worker竞争 | 同内容复用一条receipt；改参冲突；仅一个外发 |
| A03 | 一个turn内部3次模型调用 | 三个dispatch、三次实际HTTP，各预算计数一次 |
| A04 | SDK收到429/500、无效JSON | 无隐藏付费重试/修复；已返回文本保留 |
| A05 | reserve后、发送后、响应落库后分别崩溃 | 分别安全取消/未知/本地重解析，不笼统重跑 |
| A06 | 用户停止后远端迟到成功；opening后summary失败 | 迟到仅结算不发布；恢复目标run/step精确，旧cursor冲突，不重跑opening |
| A07 | 预算不足、unknown费用后补、价格未知 | 预检或有界停止；只补一次账，不无依据退款；严格金额上限拒绝无价格上界连接 |
| A08 | 工具schema改变、name冲突、catalog新增 | 固定版本，冲突可辨，新工具不自动启用 |
| A09 | DNS重绑定、跨host重定向、私网URL、超大schema | dispatch前或受控传输中拒绝，不泄露凭据 |
| A10 | OAuth state重放、其他owner连接、授权过期 | 拒绝并要求对应连接恢复，不跨用户借用 |
| A11 | A/H/US代码、万元/元、币种、YTD/季度混合 | 正规化后口径保留；未知不猜、不加总不同比 |
| A12 | 1000+行分多页且一页失败；来源新增v2 | 完整时计算用全量；失败partial不可称完整；有效v1引用不因v2出现被误撤销 |
| A13 | 20份PDF/DOCX/OCR与人工金标 | 关键表格字段准确率目标≥98%，PDF原页定位和DOCX段落/表格定位各100%；未达类型受限 |
| A14 | 20个统计golden、seed和固定依赖 | 结果在定义容差内，图表和数据hash可复算 |
| A15 | 10个回测情景、复权序列误作成交价与未来信息 | 手算一致；撮合拒绝非成交价格口径；validated仅固定模板，自由代码标exploratory |
| A16 | 多账户日报与两个成员分别取得新证据 | 完整冻结事实；各自新引用可用、互引拒绝、解封后引用保留；不意外激活策略 |
| A17 | 采集/解析/计算期间停用/删除来源；私密数据生成图表后外发 | 取消后续使用，迟到提交拒绝，不经cache复活；派生产物继承最严格外发限制 |
| A18 | 中文15题、英文15题固定搜索任务 | 分语言记录命中/正文/支持率/延迟/成本；关键数值和单位错误0，引用支持率目标≥95% |
| A19 | 虚构登录站点、表单、私网跳转、浏览器崩溃；云后端真实限额测试 | 来源隔离、写入受控、会话可回收；云导航/重定向/子资源/下载策略独立验证，不继承本地结果 |
| A20 | 用户尚未确认外部草稿 | 零外部写入，预览准确显示目标/内容/附件 |
| A21 | 重复确认或修改目标后提交旧确认 | 一条本地执行receipt；旧hash拒绝 |
| A22 | Composio已执行但本地timeout | 状态unknown，无自动重试；核验后才标完成 |
| A23 | 删除来源后的memory/report/trace下载 | 遵守既有可见性，历史快照不凭空改变且原文不复活 |
| A24 | exporter失败、费用未知、输出含敏感字段 | 业务结果不变，cost为null，外部trace无私密内容 |
| A25 | Deep Agents子代理/隐藏调用/上下文压缩 | 共享预算权限、所有调用可计数、冻结事实完整、单循环权威 |

## 21. 测试环境和最终命令

新增测试脚本在各工作包实际添加测试文件时注册，不能把不存在的glob当成功。推荐分别增加`test:agent-runtime`、`test:tool-connections`、`test:research-artifacts`、`test:research-data`、`test:research-documents`、`test:research-compute`、`test:tool-actions`，其命令使用对应工作包列出的tsx入口；实际云验收另设显式`live`命令，默认CI禁止执行。

临时数据库按套件配置：`BUDGET_TEST_DATABASE_URL`、`COUNCIL_TEST_DATABASE_URL`、`RESEARCH_TEST_DATABASE_URL`、`STRATEGY_TEST_DATABASE_URL`、`MEMORY_TEST_DATABASE_URL`、`EXPERIENCE_TEST_DATABASE_URL`、`AUTH_TEST_DATABASE_URL`、`HISTORY_TEST_DATABASE_URL`、`TELEMETRY_TEST_DATABASE_URL`和`WIRING_TEST_DATABASE_URL`。每套fixture检查目标为测试数据库。Wiring不启动scheduler；普通应用启动会迁移和启动后台任务，不能用个人实例做smoke。

实现完成后执行：

```powershell
npm run lint
npm run test:server
npm run test:client
npm run test:local-agents
npm run test:browser
npm run test:telemetry
npm run test:memory-eval
npm run test:architecture
npm run test:wiring
npm run test:context
npm run check:context
npm run build:web
git diff --check
```

离线Python分析与原`agent/`测试分别运行，不能因新增analytics替代既有Agent tests。受保护CI仍要求 **Lint & typecheck、Agent tests、Docker image build**；开发阶段不恢复Desktop打包要求。

## 22. 文档与交付检查表

- [ ] 当前README/使用文档区分“已实现”“需配置”“未验证”，不把本计划写成已上线功能。
- [ ] 架构图1–2加入运行/工具/产物数据流；图3–5确认没有新增交易或真实账本写入口。
- [ ] 中英文工具状态、失败码、确认文案、费用未知和来源缺口完整。
- [ ] 备份说明覆盖DB、加密密钥、artifact、本地browser状态；云端授权/日志保留单独说明。
- [ ] 各供应商记录实际版本、协议、账户权限、数据外发范围、使用额度和测试时间。
- [ ] PR包含行为变化、关键测试、真实连接验证与尚未完成项；不绕过保护规则。
- [ ] 生产切换前以当前实际实例定位和匹配备份为依据，不照抄旧路径或PID。
- [ ] 用户验收后决定启用范围；关闭新能力后仍可读取原报告、使用旧研究路径和既有模拟盘。

本计划在审阅前不执行上述步骤。审阅建议先看总体设计第16节的决策，再看本计划第1节的阶段范围及第20节的验收标准。
