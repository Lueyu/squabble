---
name: squabble-contributor
description: Use when developing, debugging, testing, documenting, deploying or maintaining Lueyu/squabble, or resuming Squabble work in a new chat.
---

# Squabble 开发与维护

仓库中的 `.agents/skills/squabble-contributor/` 是维护正本；全局安装目录是可发现的副本。目标是从已核对的入口开始工作，按改动增量读取代码。此 skill 不授予合并、部署、付费研究或交易权限；沿用当前会话已有授权。

## 新聊天从这里开始

1. 使用当前项目目录或用户明确指定的仓库。需要定位项目时，读取私有 `~/.squabble/development-context.json` 中的路径提示；不要遍历整块磁盘或根据旧 PID 操作服务。
2. 从已安装 skill 或仓库正本运行 `node <skill目录>/scripts/inspect-workspace.cjs --repo <仓库根目录>`。它只读 Git 状态、知识版本、路径和迁移登记；不会安装依赖、迁移数据库或调用 AI。`--config <私有配置文件>` 仅补充位置提示。
3. 优先读取当前 checkout 的本 skill 和下面与任务有关的参考资料。`context-manifest.json` 记录核对基线、模块入口和相关图。版本差异、缺失基线和脏文件需要定向核对，不代表运行实例损坏。不要把旧文档当作当前代码的证明，也不要重新通读整个仓库。
4. 明确是当前简化体验还是保留的旧流程，再打开对应入口。当前 `/council` 通过 `SimpleCouncilPage` 进入频道；旧 `CouncilPage` 和 `multi-agent/` 分析仍存在。
5. 当前 `/` 为账户表现总览，`/paper` 为多模拟仓列表，`/paper/:accountId/strategies` 管理该仓组合；比较和频道账户选择是只读操作，不替代显式应用。旧无账户接口保留歧义与托管账户保护。
6. 共享研究基础在 `server/modules/research-core/`，执行器选择在 `research-routing/`；策略界面在 `client/src/features/investment-strategies/`。不要把旧目录名当作功能归属；中文阅读顺序见 `docs/code-reading.zh-CN.md`。
7. V4 新入口为 `/daily`、`/research`、`/data`、`/memory`；策略问答在 `client/src/features/strategy-interview/` 和 `/strategies`。访谈采纳与执行授权分开；已保存预览只能通过只读 `GET /api/strategy-interviews/:id/review` 恢复，不得重新生成时丢失观察意图。导航返回/滚动逻辑在 `features/navigation/`，通知/MCP 复用面板在 `features/integrations/`。
8. `/research` 复用持久化研究会话的大框聊天与历史侧栏，不是能力超链接入口。报告历史逐条删除一个版本；研究任务删除不级联报告。迁移 `49_research_deletions.sql` 保留墓碑和请求回执，已运行或提供方状态未确定的任务先结算。删除来源不可再次同步、调用记忆、执行策略或发布新频道内容；已有成交和固定快照保留，删除已采纳版本只清空采纳指针。
9. V5 研究室侧栏同时拥有策略库；`/strategy` 在同页恢复多轮访谈，其他 slash skills 固定受信清单版本与 hash，聊天展示真实公开活动。`server/modules/data-library/` 拥有资料、订阅、金融查询与迁移50；`features/data-library/` 复用于数据中心和记忆资料来源。`/settings/data` 重定向到 `/data?tab=financial`。资料检索与后续研究复验 owner、精确版本和启停/删除状态；资料原文不是采纳结论，更不是持仓导入。详见 `docs/research-data-workspace.md`。
10. 迁移51增加浏览器采集与会话隔离。`data-library/browser/` 负责专用浏览器和固定公共IP的出口；`data-browser.service.ts` 负责人工登录确认、加密状态和断开；`read_browser_source` 工具仅接收已保存来源ID，经统一job/version路径返回渲染正文。浏览器登录不在同步租约内；最终提交复核lease token、job和revision。无浏览器或无法交互时明确不可用，不开放全局MCP、不把HTTP Basic当网页登录。安装浏览器及验证见 `docs/browser-source-collection.md`。

所有反引号内的仓库路径都相对于选定仓库；参考文件之间的链接相对于 skill。

| 当前任务 | 按需读取 |
|---|---|
| 找页面、API、业务模块、数据归属 | [仓库地图](references/repository-map.md) |
| 日报、报告历史、策略导入/确认、模拟盘、频道 | [研究与执行契约](references/research-and-execution.md) |
| 开发启动、隔离测试、CI、UI 验收 | [开发与测试](references/development-and-tests.md) |
| 更新正在使用的实例、Docker、备份或回退 | [部署与恢复](references/deployment-and-recovery.md) |
| 排错、文档过期、每次改动的知识维护 | [维护指南](references/maintenance.md) |

## 开发与交付约定

- 在已有隔离工作区或从当前 main 建立的分支工作，保留用户已有改动。当前阶段仅开发 Web；使用 `npm run build:web`。Desktop 保留作手动恢复，不默认要求安装包测试。
- 先明确用户能观察到的行为和受影响契约，再实现和验证。行为修改同步中英文文案；假数据与临时测试数据库用于验证。缺少数据库前置条件导致的 skip 不算集成测试通过。
- 当前日报先独立封存判断，再反向核查。报告可读、历史可查；报告策略导入不重复抽取或自动激活。策略确认采用持久化内容的预览哈希，并在最终事务中复核修订和来源。自动交易的对象是模拟盘。
- 每次改动检查 `docs/architecture.md` 的五张图及 skill 中受影响的介绍、入口、测试和运行手册。结构或数据流变化必须同步修改；结构未变则记录核对结论，不能只改日期掩盖未核对内容。详见维护指南。
- 运行适合改动的检查及 `npm run test:context`、`npm run check:context`。机械校验检查路径和元数据，不能替代对图和文字的语义核对。
- 新模块遵守现有静态依赖检查；涉及模块归属时运行 `npm run test:architecture`。注释说明职责、状态转换和副作用边界；使用常规多行格式，不压缩代码来减少行数。
- 通过 PR 进入 main。必需检查为 **Lint & typecheck**、**Agent tests**、**Docker image build**；处理评审意见，不绕过保护。当前 `CONTRIBUTING.md`、CI 和仓库分支规则是合并要求的依据。
- 合并后同步全局副本：先运行 `node <skill目录>/scripts/sync-skill.cjs --repo <仓库>` 查看计划，再在已获安装/更新授权的范围内加 `--apply`。保留安装版本信息；不要手动维护第二份知识。

完成交付时说明行为/文档改动、验证结果、架构与知识更新、PR 和安装版本，以及实际剩余限制。只有用户要求部署应用时才走实例切换流程。

## Agent 运行分析

`/telemetry` 提供总览、成员比较、运行列表、Trace 与反馈/质量视图；`shared/telemetry.interface.ts` 定义未知值与统计口径。`server/modules/telemetry/` 读取所属用户来源并尊重删除墓碑，迁移52持久化观测元数据和反馈。模型/本地助手/工具的采集不改变执行结果。Langfuse 默认不启用，只有显式配置后导出元数据；不得将提示词、回答、持仓或密钥写入导出。详见 `docs/agent-telemetry.md`；使用临时 `TELEMETRY_TEST_DATABASE_URL` 运行 `npm run test:telemetry`，浏览界面不能触发研究。
