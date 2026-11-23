# Archived AI iteration records · AI 迭代记录归档

This folder keeps the distilled result of the AI-authored design, planning and
validation records that accumulated under `docs/`. Each sub-folder is a single
topic with one `README.md` that preserves the decisions, numbers and limits worth
keeping, while the original per-run documents were removed from the tree.

这些文档来自 AI 辅助的开发过程（设计方案、实施计划、验收记录）。原文件已从
`docs/` 删除，核心结论与验证数据按主题提炼到本目录；它们是**历史证据**，说明
某个阶段的设计与验收状态，而不是对当前 checkout 的承诺。

## Topics · 主题

| Folder | Covers | 覆盖内容 |
|---|---|---|
| [01-tooling/](01-tooling/README.md) | Agent tooling, bundled capabilities and local sandbox, source-host tools, browser-source collection, Clowder research | Agent 工具链、内置能力与本地沙箱、源站工具、浏览器来源采集 |
| [02-research/](02-research/README.md) | Research–strategy loop, research experience recovery, simple simulation loop, research memory roadmap, development skill and maintainability work | 研究策略闭环、研究体验恢复、简单模拟循环、研究记忆路线、开发技能与可维护性 |
| [03-product-history/](03-product-history/README.md) | Simplified product proposal, one-click analysis, Council personas, settings navigation, AI friend V4, competitive analysis, review resolution | 简化版产品方案、一键分析、投委会人格、设置导航、AI 股友 V4、竞品分析、评审处理 |
| [04-future-designs/](04-future-designs/README.md) | V5 data center, Figma designs, research data and skill designs, V4 overview refresh, V4 research records, V4 delivery verification | V5 数据中心、Figma 设计、研究数据与技能设计、V4 总览刷新与研究记录、V4 交付验证 |

## What stays in `docs/`

Product and user guides stay in `docs/` (see [docs/README.md](../README.md)).
Approved specifications for shipped features also stay there until the feature
is superseded — for example the team-paper specs and the guided-teams spec that
are linked from the documentation index. This archive only holds the iteration
records that no longer describe the current checkout.
