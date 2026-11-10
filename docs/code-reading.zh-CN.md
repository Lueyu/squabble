# 从一次研究读懂 Squabble

Squabble 的主线是一款智能投资助手：理解持仓，多位研究者形成观点与反向核查，
把结果写成报告，再通过股友频道持续呈现变化。模拟盘用于观察经用户确认的策略如何执行。
阅读代码时先跟一条用户路径，再按需展开基础服务，比从最大文件开始更容易理解。

本文面向当前 Web。路由及新旧体验选择见 [app.tsx](../client/src/app.tsx) 和
[体验开关](../server/common/platform/simple-experience.ts)；旧分析、投委会 API 和历史报告读取仍可达。
环境搭建与命令以[开发指南](development.md)为准，完整数据流见[架构图](architecture.md)。

## 跟随“账户总览 → 报告 → 账户组合 → 频道”

1. **总览先读取已保存表现，再进入研究。** 从
   [PortfolioOverviewPage](../client/src/pages/Overview/PortfolioOverviewPage.tsx) 和
   [PortfolioComparisonService](../server/modules/paper-trading/portfolio-comparison.service.ts)
   看真实资产与多个模拟仓如何只读比较；缺失值、资金流和基线变化由
   [portfolio-comparison.rules.ts](../server/modules/paper-trading/portfolio-comparison.rules.ts) 保持未知。
   `/analysis` 的 [SimpleAnalysisPage](../client/src/pages/Analysis/SimpleAnalysisPage.tsx) 组合
   [CurrentAnalysisPanel](../client/src/pages/Today/CurrentAnalysisPanel.tsx)，
   [CurrentResearchService](../server/modules/experience/current-research.service.ts) 选择当前报告。
   当前展示是可变投影，报告历史是独立版本；不能用“最新”替换用户打开的历史 ID。
2. **研究者开展研究，系统验收结果。**
   [daily-channel-research.service.ts](../server/modules/experience/daily-channel-research.service.ts)
   衔接日常研究，[council.daily.ts](../server/modules/council/council.daily.ts) 与
   [council.workflow-executor.ts](../server/modules/council/council.workflow-executor.ts)
   组织独立研究、反向核查和总结。[研究路由](../server/modules/research-routing/portfolio-research-route.service.ts)
   选择可用执行器；API 模型调用和原生 Agent 任务保有各自的执行与用量记录。
   原生任务完成、结果被本地接受、报告发布成功是三个状态，恢复逻辑见
   [council-report-resume.service.ts](../server/modules/council/council-report-resume.service.ts)。
3. **保存可阅读的报告。**
   [ResearchDocumentsService](../server/modules/research-documents/research-documents.service.ts)
   管理版本与来源，[shared/research-reading.ts](../shared/research-reading.ts)
   整理可读内容，[SimpleReportReader](../client/src/pages/Analysis/SimpleReportReader.tsx)
   展示报告。保留原始结果允许本地重新整理已知格式，不必重跑研究。
4. **把建议带到策略草稿。**
   [ReportExecutionPlan](../client/src/components/ReportExecutionPlan.tsx) 提供报告入口，
   [InvestmentStrategySourceDialog](../client/src/features/investment-strategies/InvestmentStrategySourceDialog.tsx)
   选择来源，[UserInvestmentStrategyService](../server/modules/paper-trading/user-investment-strategy.service.ts)
   保存策略库草稿。[ReportStrategyTarget](../client/src/features/investment-strategies/ReportStrategyTarget.tsx)
   将其加入明确选择的账户组合草稿，新增项默认停用。结构化计划保留原条件，普通正文作为观察材料；导入不授予执行权限。
5. **审阅后应用到账户组合。**
   [SimulationAccountsPage](../client/src/pages/Paper/SimulationAccountsPage.tsx) 创建互不替换的独立账户，
   [SimulationAccountPage](../client/src/pages/Paper/SimulationAccountPage.tsx) 展示该仓状态，
   [AccountStrategyCombinationPage](../client/src/features/investment-strategies/AccountStrategyCombinationPage.tsx)
   管理启用项、预算与预览。[PortfolioWorkspaceService](../server/modules/paper-trading/portfolio-workspace.service.ts)
   在事务内复核账户、policy 修订、组合哈希和来源，保存不可变组合修订；
   [user-strategy-runtime.ts](../server/modules/paper-trading/user-strategy-runtime.ts) 为每仓安装一个 profile/mandate，
   [strategy-allocation.ts](../server/modules/paper-trading/strategy-allocation.ts) 在共享现金与风控之外检查策略预算。
   保存草稿不影响运行；明确应用或暂停只影响选定账户。旧 `AiInvestmentPage` 和全局单策略 API 是兼容代码。
6. **频道解释变化，模拟账本记录结果。**
   [SimpleCouncilPage](../client/src/pages/Council/SimpleCouncilPage.tsx) 进入
   [ChannelWorkbench](../client/src/pages/Channel/ChannelWorkbench.tsx)。
   [channel-contract.ts](../server/modules/channel/channel-contract.ts) 定义发布契约，
   [channel-runtime.ts](../server/modules/channel/channel-runtime.ts) 只读所选账户全部启用策略及成交状态。
   监控、发布与成交保留账户/策略/条目标识，未选择多账户中的一个时不任选当前仓。
   研究观点、待应用建议与实际成交分开显示；一条频道文案不能取代订单记录或授权校验。

## 模块各自负责什么

| 目录 | 责任与边界 |
|---|---|
| `server/modules/experience/` | 组合资产和当前研究入口，并保留 Today API；新总览比较由 paper-trading 模块负责，不拥有通用模型执行器选择。 |
| `server/modules/council/` | 多 Agent 会话、研究步骤、结果验收和恢复；不是通用数据源适配层。 |
| `server/modules/research-core/` | 共用模型调用、证据收集、财务来源适配与组合上下文；供当前和保留研究流程使用，不依赖它们的编排。 |
| `server/modules/research-routing/` | 选择可用的研究执行器，由独立 Nest 模块导出；当前研究和模拟投资共用。 |
| `server/modules/research-documents/` | 报告版本、引用和发布记录；与页面当前选中的报告区分。 |
| `server/modules/paper-trading/` | 账户策略组合、执行条件、模拟账本和已保存表现比较；真实资产账本仍由导入、交易等模块负责。 |
| `server/modules/channel/` | 把研究发现、待决定事项和运行状态编译成频道内容。 |
| `client/src/features/investment-strategies/` | 跨页面的策略来源、编辑、审阅和管理；页面组合功能，功能不反向依赖页面。 |
| `shared/` | 前后端共享的接口与纯规则，不导入客户端或服务端实现。 |
| `server/modules/multi-agent/` | 保留的分析运行、旧流水线和报告生成；本次整理未删除这些 API 或历史读取入口。 |

策略目录内可按 [use-investment-strategy-editor.ts](../client/src/features/investment-strategies/use-investment-strategy-editor.ts)
→ [StrategyEditorForm](../client/src/features/investment-strategies/StrategyEditorForm.tsx)
→ [StrategyExecutionReview](../client/src/features/investment-strategies/StrategyExecutionReview.tsx)
阅读：先理解草稿、保存、准备回执和应用操作，再看表单输入与执行说明如何呈现。

基础研究层从 [ResearchCoreModule](../server/modules/research-core/research-core.module.ts)
查看提供者关系，再按需求读 [LlmService](../server/modules/research-core/llm.service.ts)、
[EvidenceService](../server/modules/research-core/evidence.service.ts) 或
[PortfolioContextService](../server/modules/research-core/portfolio-context.service.ts)。
注意一处保留边界：Settings 仍注册自己的 `LlmService`，本次没有重做全局设置依赖；
原生执行器通过延迟查询取得，Core 不直接导入 `LocalAgentsModule`。

## 为什么这样划分

- **保持一个可部署应用。** React、Nest 和 PostgreSQL 继续组成同一应用，先用模块边界降低耦合。
  这比立即拆成多个服务更容易本地运行，也保留现有事务；代价是仍需检查 Nest 注入关系和启动顺序。
- **基础能力与研究编排分开。** `research-core` 可以被多个流程共用，研究角色和流程顺序留在 Council。
  新数据源优先进入基础层，新研究步骤进入编排层，不为每个入口复制一套模型与证据服务。
- **页面组合，功能管理状态。** 策略功能可由报告和模拟盘共用；编辑操作、表单和执行审阅分别阅读。
  异步回执和请求标识仍需明确保存，拆文件本身不能消除迟到响应、重复提交或未知执行结果。
- **保留快照与确认边界。** 报告、草稿、确认策略和成交记录各自有生命周期。
  这些区分使恢复、历史阅读和并发编辑更可靠，代价是状态较多；注释应解释这些边界为何存在，
  不能为了减少分支把它们合成一个“成功”状态。

## 改动时怎样验证

先声明要保留的用户行为，再选对应测试。
[portfolio-workspace.integration.spec.ts](../server/modules/paper-trading/portfolio-workspace.integration.spec.ts)
覆盖升级、独立账户和完整重复启动；
[portfolio-runtime.integration.spec.ts](../server/modules/paper-trading/portfolio-runtime.integration.spec.ts)
覆盖两仓运行及暂停隔离；
[portfolio-capacity.integration.spec.ts](../server/modules/paper-trading/portfolio-capacity.integration.spec.ts)
区分 100 个组合执行标的与每市场 20 个非固定 AI 讨论标的上限；
[portfolio-comparison.integration.spec.ts](../server/modules/paper-trading/portfolio-comparison.integration.spec.ts)
验证保存估值只读投影；
[portfolio-combination-flow.test.cjs](../client/src/utils/portfolio-combination-flow.test.cjs)
覆盖组合界面；
[channel-workspace.integration.spec.ts](../server/modules/channel/channel-workspace.integration.spec.ts)
覆盖频道账户来源边界。原有研究恢复与最终下单测试继续保留。
完整选择表见[测试参考](../.agents/skills/squabble-contributor/references/development-and-tests.md)。

`npm run test:server` 包含需要 PostgreSQL 的集成测试；它不是纯离线单元测试命令。
数据库必须是一次性隔离实例，缺前置条件的跳过不算集成验证通过。
现有 React/JSDOM 交互、服务和数据库测试值得保留，但不能据此声称完整浏览器到后端旅程已经验收。
代码注释用英文解释输入、输出、副作用和不易看出的约束；中文导读负责解释跨模块的阅读顺序。

新增的 `npm run test:architecture` 验证静态依赖方向；`npm run test:wiring` 用
`WIRING_TEST_DATABASE_URL` 指定的一次性数据库检查编译后 Nest 模块能否装配，
不会启动定时任务。后者仍会执行测试库迁移，不能指向个人实例。

## 已有能力与下一步

| 状态 | 内容 |
|---|---|
| 已有实现 | 持仓上下文、多 Agent 研究和反向核查、可阅读报告、股友频道、策略审阅应用、模拟执行和保留历史。具体可用能力仍取决于模型连接、资料和账户配置。 |
| 本次账户工作区 | 多模拟仓独立组合、预算、暂停与按账户频道；只读表现比较。迁移 45 与历史迁移 42 的兼容修改支持完整重复启动。研究不可变档案与真实账本写入边界保持。 |
| 可独立实施的后续工作 | 增加使用虚构数据和受控研究执行器的浏览器到后端演示旅程；按实际问题继续拆分大服务；在核对调用者、历史读取与迁移后逐步退出旧流程。 |
| 需要另行设计和验证 | 更丰富的 Agent 协作、个性化观点质量、对话体验和自动化范围。应先定义用户可见结果和评价方法，再扩展编排。 |

用于项目展示时，可以沿这条路径讲清一次输入如何变成观点、报告、用户决定和模拟结果，
并展示失败恢复与测试证据。现有代码不构成投资收益、研究质量提升、性能增益或开源关注度的证明。
