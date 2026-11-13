# Squabble documentation · 文档导航

Squabble is an investing assistant built around portfolio research, multiple
agent perspectives, readable reports and a stock-friend channel. The current
guided Web journey is **Import holdings → Meet your agents → Create your team**;
open Research later for a specific question. Explicit startup authorization bounds
automatic team research and paper execution. Manual report imports remain disabled
account drafts until explicitly applied.

吵股是一款智能投资助手：围绕持仓开展多 Agent 研究，用报告和股友频道呈现观点与变化。
当前新手流程是**导入持仓 → 认识股友 → 创建自己的团队**，有具体问题再去研究室。一次启动确认约束自动研究与模拟执行；保留的手动报告导入仍先保存默认停用草稿，明确应用后才执行。

## Start and use · 安装与使用

| Goal / 目标 | Guide / 指南 |
|---|---|
| Start with persistent agents and a guided team / 独立股友与三步建队 | [Guide](independent-agents.md) / [中文指南](independent-agents.zh-CN.md) · [Validation and limits](independent-agents-validation.md) |
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
| Prepare bundled tools and add custom tools / 内置工具与自定义接入 | [Tool operations / 工具使用](agent-tooling.md) · [Bundle design / 套件设计](superpowers/specs/2026-11-11-bundled-capabilities-design.md) · [Implementation plan / 实施计划](superpowers/plans/2026-11-11-bundled-capabilities.md) |

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

### Tooling design history · 工具设计记录

- [Agent tooling design / Agent 工具体系设计](superpowers/specs/2026-11-11-agent-tooling-design.md) and [development plan / 开发计划](superpowers/plans/2026-11-11-agent-tooling-implementation.md): the foundation was implemented in PR93; see [acceptance limits](agent-tooling-validation.md). [Bundled capabilities](superpowers/specs/2026-11-11-bundled-capabilities-design.md) supersedes its E2B-first deployment choice with a required local container sandbox. 工具基础已由 PR93 实现；套件设计将默认计算改为必备本地沙箱，实际验证记录与设计承诺分开。

### Team workspace · 团队模拟盘

- [Team paper portfolios / 团队模拟盘审核入口](superpowers/specs/2026-11-12-team-paper-review.zh-CN.md): approved product and technical specifications, now implemented with editable organization canvases and 10 starting templates. 原型与详细方案已批准；实现入口见 [使用指南](team-workspace.md)，实际检查和限制见 [验证记录](team-workspace-validation.md)。

### Independent-agent design and implementation · 独立股友设计与实现

- [Independent agents and guided teams / 独立股友与引导式团队](superpowers/specs/2026-11-12-independent-agents-guided-teams-design.zh-CN.md): approved specification implemented by this change. See the [current guide](independent-agents.md) and [verification record](independent-agents-validation.md) for actual checks and limits. 用户已批准并授权实施；默认三步引导、独立股友、团队自动运行、真实 A2A 与运行分析已形成实现，验收结果以验证记录和 PR 为准。RL/RSI 与五人新手实测仍为后续工作。
- [UI repair design / 股友身份与页面职责整改](ui-regression-repair-design.zh-CN.md), [implementation plan / 实施计划](ui-regression-repair-plan.md) and [validation / 验证记录](ui-regression-repair-validation.md): animal identity, distinct investment/holdings destinations and retained guided setup requests. 本轮更正导航与身份链路；浏览器、CI 和部署状态以独立验证记录为准。
- [UI alignment audit / 界面对齐整改](ui-alignment-audit-design.zh-CN.md), [plan / 计划](ui-alignment-audit-plan.md) and [probe commands / 探针命令](../.ui/README.md): measured card alignment, responsive controls and fictional browser evidence; run-local snapshots are separate from a human-approved baseline.

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

## Independent agents and guided teams

- [用户指南（中文）](independent-agents.zh-CN.md) / [User guide](independent-agents.md)
- [Implementation validation and limits](independent-agents-validation.md)
