# Squabble 架构总览

Squabble 用同一套 React 客户端和 NestJS API 提供 Web 和 Electron 桌面体验。服务端按用户隔离实仓、模拟仓、研究任务和团队数据。PostgreSQL 保存业务记录，Drizzle 定义应用读取及写入的表结构。可以从账户总览开始跟读一个完整流程。 [中文代码阅读指南](./code-reading.zh-CN.md) · [架构与数据流](./architecture.md)

## 代码入口

| 目录 | 职责 |
| --- | --- |
| [`client/src/`](../client/src/) | React 页面与交互。 `app.tsx` 装配路由，`pages/` 组合业务页面，`features/` 管理功能与工作流，`api/` 封装 HTTP。 |
| [`server/`](../server/) | `main.ts` 启动 NestJS，`app.module.ts` 装配模块。`modules/` 处理业务，`common/platform/` 提供鉴权、数据库依赖注入和静态文件服务。 |
| [`shared/`](../shared/) | 前后端共用的契约和常量。团队、模型连接等领域有各自的契约文件。 |
| [`desktop/`](../desktop/) | Electron 应用和本地运行时。桌面端启动应用服务，并通过回环地址访问。 |
| [`server/local-agents/`](../server/local-agents/) 与 [`agent/`](../agent/) | 宿主侧负责本地 Agent 的发现、登录、环境与工具桥接。`agent/` 是独立的可选 Python CLI 与库。 |
| [`workers/`](../workers/) | 工具包配套的文档解析、金融数据、分析及沙箱运行组件。 |
| [`scripts/db/`](../scripts/db/) | PostgreSQL 初始化与增量迁移。应用表定义在 [`server/database/`](../server/database/)。 |

`ViewModule` 放在 `app.module.ts` 的末尾，让 SPA 的通配回退排在 API 路由之后。业务接口从鉴权上下文取用户 ID，并用该 ID 查找用户数据。 [模块装配](../server/app.module.ts) · [平台层](../server/common/platform/)

## 团队与模拟盘

`/teams` 和 `/teams/:id` 提供团队列表和工作区。`teams` 负责组织草稿、发布版本、团队与账户的绑定，以及有限额度的委托。组织蓝图把角色、依赖和复核要求编译成工作计划。正式委托固定已发布的版本和工作计划。谁能在某个团队席位工作，由团队配置和已固定的股友版本共同决定。 [团队页面](../client/src/pages/Teams/) · [团队模块](../server/modules/teams/) · [股友模块](../server/modules/agent-roster/)

`team-runs` 管理显式启动授权和有限的调度周期。`council` 执行研究。`paper-trading` 持有模拟仓、策略组合和模拟台账。在研究结果进入台账前，执行路径仍须满足对应账户的绑定与授权。 [团队运行](../server/modules/team-runs/) · [研究执行](../server/modules/council/) · [模拟交易](../server/modules/paper-trading/)

`/` 展示账户表现，`/holdings/accounts` 管理模拟仓。`portfolio-history` 负责账户估值及历史参考所需的市场事实，实仓记录和模拟仓台账由各自写入路径维护。 [账户估值](../server/modules/portfolio-history/) · [当前路由](../client/src/app.tsx)

## 研究与策略

| 入口 | 实现 |
| --- | --- |
| `/research` | 持久化研究对话与历史。`research-core` 共享提示、证据和模型基础设施。`research-routing` 选定执行器，`council` 负责研究会话与发布，`research-runtime` 保存模型和工具步骤的运行状态。 |
| `/council` | 频道投影与操作，页面入口为 `SimpleCouncilPage`。旧 `multi-agent` 分析与历史读取仍有独立入口。 |
| `/strategies` | 策略库和访谈，前端入口在 `features/strategy-interview/`，访谈接口由 `paper-trading` 模块装配。 |
| `/paper/:accountId/strategies` | 指定模拟仓的策略组合。导入、编辑和组合管理使用 `features/investment-strategies/`。采纳策略与授权运行是独立操作。 |
| `/data` 与 `/memory` | 资料、金融来源及研究记忆。资料版本、所有者范围与删除状态在消费时复核。 |

[客户端功能目录](../client/src/features/) · [服务端模块](../server/modules/) · [研究与资料工作区](./research-data-workspace.md)

## 模型连接与工具进程

设置模块管理用户的 OpenAI 兼容连接。连接测试回执绑定端点、模型与凭据。修改这些字段会清除旧回执，单独改名保留回执。API 列表只返回掩码和状态。 [连接服务](../server/modules/settings/model-connections.service.ts) · [回执迁移](../scripts/db/70_model_connection_tests.sql)

| 组件 | 调用边界 |
| --- | --- |
| [`workers/documents/`](../workers/documents/) | 部署端准备的 Docling 解析服务。`research-documents` 管理持久化文档任务和解析结果。 |
| [`workers/aktools/`](../workers/aktools/) | 工具包部署的 AKTools 行情与金融数据适配，应用通过受限的已登记工具访问。 |
| [`workers/analytics/`](../workers/analytics/) | 回测与统计任务的 Python 实现，包含 Backtrader 和 QuantStats 适配。 |
| [`workers/sandbox/`](../workers/sandbox/) | 私有计算 broker 与隔离执行。 `research-compute` 提交受控任务，由 broker 创建单次任务容器。 |

服务端负责工具授权、预算和结果可见性。具体部署决定哪些 worker 可用。 [工具架构与配置](./agent-tooling.md) · [沙箱 broker](../workers/sandbox/README.md)

## 开发入口

在仓库根目录运行 `npm run lint`、`npm run build`、`npm run test:client` 和 `npm run test:server`。用 `npm run test:architecture` 检查模块依赖方向，用 `npm run test:wiring` 检查编译后的 Nest 依赖装配。 [贡献指南](../CONTRIBUTING.md) · [文档索引](./README.md)
