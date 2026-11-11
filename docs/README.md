# Squabble documentation · 文档导航

Squabble is an investing assistant built around portfolio research, multiple
agent perspectives, readable reports and a stock-friend channel. The current Web
journey is **Portfolio overview → Research reports → Choose a simulation → Review
and apply its combination → Channel**. Accounts run independently; report imports
remain disabled account drafts until explicitly applied.

吵股是一款智能投资助手：围绕持仓开展多 Agent 研究，用报告和股友频道呈现观点与变化。
当前 Web 日常流程是**投资总览 → 研究报告 → 选择模拟仓并核对组合 → 频道**；多个模拟仓独立运行，报告导入先保存默认停用的账户草稿，明确应用后才用于模拟执行。

## Start and use · 安装与使用

| Goal / 目标 | Guide / 指南 |
|---|---|
| Navigate V4, clarify a strategy and manage companions / V4 导航、策略问答与股友 | [AI companion workspace / AI 股友工作区](ai-friend-v4.md) |
| Understand V4 account and daily contracts / V4 账户、日报与记忆契约 | [Portfolio workspace](v4-portfolio-workspace.md) · [Daily and memory](v4-daily-and-memory-workspace.md) · [Verification](v4-delivery.md) · [Imported-portfolio history](portfolio-history-reference.md) |
| Run the Web app locally / 本地运行 Web | [Local setup](self-hosting.md#docker-compose) · [本地安装](self-hosting.zh-CN.md#docker-compose) |
| Follow a report through simulation / 从报告走到模拟盘 | [Assets, reports and strategies / 资产、报告与策略](assets-reports-strategy.md) |
| Read stock-friend opinions and execution updates / 阅读股友观点与执行动态 | [Channel workbench / 频道](channel-workbench.md) |
| Connect models and native research agents / 连接模型与本地研究 Agent | [Local agents / 本地 Agent](local-agents.md) · [Model connections and budgets](investment-council.md) / [模型连接与预算](investment-council.zh-CN.md) |
| Record holdings and transactions / 记录持仓与交易 | [Portfolio import / 持仓导入](import.md) |
| Understand data and privacy / 了解数据来源与隐私 | [Research data / 研究数据](research-data.md) · [Privacy](privacy.md) / [隐私](privacy.zh-CN.md) |
| Change appearance / 调整外观 | [Appearance / 外观](appearance.md) |
| Analyze Agent runs and connect Langfuse / 分析 Agent 运行与连接 Langfuse | [Agent telemetry / 运行分析](agent-telemetry.md) |

Starting an empty workspace does not require the optional Python agent or a model
key. AI research requires an available configured model or native agent. Desktop
installation instructions remain in [self-hosting](self-hosting.md#desktop-app) /
[自托管指南](self-hosting.zh-CN.md#桌面应用); desktop development and packaging are
currently paused. Native-agent setup documents explain when a desktop companion
is needed for local Docker.

## Read and contribute · 阅读代码与参与开发

- [代码阅读指南（中文）](code-reading.zh-CN.md): follow the current journey, module responsibilities, design tradeoffs and future work.
- [Development](development.md): source setup, current commands and disposable database prerequisites.
- [Architecture](architecture.md): five maintained flows and current versus retained boundaries.
- [Portfolio workspace design](portfolio-workspace-design.md), [implementation plan](portfolio-workspace-plan.md) and [validation record](portfolio-workspace-validation.md): reviewed screens, account contracts and delivery checks.
- [Contributing](../CONTRIBUTING.md): PR checks, translations and change review.
- [Squabble contributor skill](../.agents/skills/squabble-contributor/SKILL.md): targeted source map, tests and maintenance instructions for coding agents.
- [Deployment and recovery runbook](../.agents/skills/squabble-contributor/references/deployment-and-recovery.md): inspect and update an existing private instance.
- [Security](../SECURITY.md): private vulnerability reporting.

### Pending review · 待审阅方案

- [Agent tooling design / Agent 工具体系设计](superpowers/specs/2026-11-11-agent-tooling-design.md) and [development plan / 开发计划](superpowers/plans/2026-11-11-agent-tooling-implementation.md): proposed API Agent runtime, MCP clients, financial data, document parsing, computation, browsing and app connections. These are review drafts, not implemented capabilities. 两份文档为待审阅方案，混合部署方向已确认，实施在用户审阅后开始。

## Retained workflows and history · 保留流程与历史记录

The retained analysis and Council APIs, report readers and advanced simulation
flows still exist. Their guides explain those surfaces; they are not the default
starting point for current Web changes. A historical document is evidence of a
past design or verification run, not a promise about the current checkout.

旧分析与投委会 API、报告读取和高级模拟流程仍然保留。下列资料用于理解兼容边界和历史决策，
不作为当前 Web 的默认开发入口；历史验收结果也不代表本次改动已经通过验证。

| Scope / 范围 | Documents / 资料 |
|---|---|
| Retained discussion and advanced simulation / 保留讨论与高级模拟流程 | [Council](investment-council.md) / [投委会](investment-council.zh-CN.md) · [Research–strategy loop](research-strategy-loop.md) / [研究策略闭环](research-strategy-loop.zh-CN.md) · [Paper-account MCP](mcp-paper-accounts.md) |
| Historical product proposals / 历史产品方案 | [Simplified product proposal](squabble-simple-product.zh-CN.md) · [One-click analysis plan](one-click-analysis-plan.md) |
| Historical design and roadmap / 历史设计与路线 | [Council personas](council-personas-design.md) · [Settings navigation](settings-navigation-design.md) · [Research memory roadmap](research-memory-roadmap.md) |
| Past delivery and validation / 历史交付与验收 | [Simplified experience](simple-experience-delivery.md) · [Research recovery](research-experience-recovery-delivery.md) · [Research–strategy validation](research-strategy-loop-validation.md) |

Squabble does not operate a hosted service or support public server deployment.
The [retired server guide](public-deployment.md) / [原服务器指南](public-deployment.zh-CN.md)
explains that boundary; it is not a current deployment tutorial.
