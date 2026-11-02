# Clowder Agent 接入与 Skills / MCP 实现核对

核对日期：2026-11-02。本文研究上游实现，不把上游设计文档中的规划等同于已发布功能。

## 六种 Agent 的实际含义

[官网文案源码](https://github.com/zts212653/clowder-ai/blob/main/site/i18n.js) 明确列出 Claude Code、Codex、Gemini CLI、Antigravity、opencode、Kimi。当前 [README](https://github.com/zts212653/clowder-ai/blob/main/README.md) 的表格只列四种，因此不能只看 README 来判断覆盖范围。

接入的核心是统一的 AgentService 调用接口和各供应商的运行适配器：负责启动本机 CLI、映射流式事件、设置模型、管理取消与会话，再交给上层进行角色编排。上游 [F050](https://github.com/zts212653/clowder-ai/blob/main/docs/features/F050-a2a-external-agent-onboarding.md) 明确区分内部 Agent 协作、CLI 接入与外部 A2A 协议端点；用户无需自行架设 A2A 服务来使用本机 CLI。

不同 Agent 的模型和推理能力不完全相同。上游 [KimiAgentService](https://github.com/zts212653/clowder-ai/blob/main/packages/api/src/domains/cats/services/agents/providers/KimiAgentService.ts) 明确避免向只提供布尔思考开关的模型虚构强度档位；[Antigravity 运行适配](https://github.com/zts212653/clowder-ai/blob/main/packages/api/src/domains/cats/services/agents/providers/agy-native/agy-native-launch.ts) 则有独立的 CLI、配置和权限处理。

本次对通过官方校验和验证的 Antigravity 1.4.12 Windows 程序做了隔离配置检查：`/config` 返回本次研究设置，模型轮次与 Token 用量均为 0。这确认临时配置路径有效，不等同于已登录的真实研究验收。

## “60+”指什么

官网使用的是 **60+ built-in skills / 60+ 内置技能**，不是六十个模型接口，也不是六十家已连接服务。技能通常包括 `SKILL.md`，按需附带参考文件或脚本。当前主干顶层 `cat-cafe-skills/*/SKILL.md` 的一次目录统计为 59；插件与其他技能目录另计。该数字会随版本与统计范围变化，产品标语不能代替可调用工具数量。

### 技能：让 Agent 知道怎么完成工作

- [manifest.yaml](https://github.com/zts212653/clowder-ai/blob/main/cat-cafe-skills/manifest.yaml) 记录技能分类、描述、触发条件 `triggers`、排除条件 `not_for`、预期产出 `output`、后续技能 `next`，以及可选 MCP 依赖。
- [技能同步引擎](https://github.com/zts212653/clowder-ai/blob/main/packages/api/src/skills/skill-sync-engine.ts) 把启用的技能挂到项目对应的技能发现目录，协调配置和受管理的符号链接，并支持失败回滚。
- Agent 先看到简短技能索引，匹配任务后再读取完整技能内容和所需资料，减少每轮上下文开销。这里主要利用各 Agent 的原生技能发现机制。
- [F038](https://github.com/zts212653/clowder-ai/blob/main/docs/features/F038-skills-discovery.md) 将类 ToolSearch 的 BM25/regex 延迟检索仍记录为待推进方向；不能因此宣称已实现统一的向量技能检索。
- [清单检查脚本](https://github.com/zts212653/clowder-ai/blob/main/scripts/check-skills-manifest.mjs) 校验技能文件、frontmatter、触发条件、next 链以及 MCP 依赖。

### MCP 工具：让 Agent 真正调用程序

- [canonical-server-tools.ts](https://github.com/zts212653/clowder-ai/blob/main/packages/mcp-server/src/canonical-server-tools.ts) 汇集可执行工具，按协作、记忆、信号、外部执行、音频、金融等服务分组。
- [server-toolsets.ts](https://github.com/zts212653/clowder-ai/blob/main/packages/mcp-server/src/server-toolsets.ts) 选择获准暴露的工具并调用 MCP SDK 的 `registerTool` 注册名称、说明、输入 schema 和处理函数。调用层还处理身份、取消信号、只读过滤与输出大小约束。
- [能力编排器](https://github.com/zts212653/clowder-ai/blob/main/packages/api/src/config/capabilities/capability-orchestrator.ts) 以 `.cat-cafe/capabilities.json` 为配置源，统一管理 MCP 服务。
- [provider-mcp-config.ts](https://github.com/zts212653/clowder-ai/blob/main/packages/api/src/domains/cats/services/agents/providers/provider-mcp-config.ts) 根据成员、工作区、调用范围和启用状态生成适配各运行环境的 MCP 配置。

因此，一个技能可以编排多个工具；工具也可以被多个技能共用。把技能文档复制到项目不会自动得到其依赖的数据库、搜索服务或可执行工具。

## Squabble 的应用方式

本次实现七种 Agent 与每个角色的模型/推理设置。沿用本机检测、原生登录、连接和桌面助手配对流程，配置随研究任务传递；已有任务快照保持原设置。

对于后续投研技能，可复用“简短索引 → 按需读取技能 → 调用有明确权限的工具”的组织方式，例如财报核查、估值比较、反方审查、来源交叉验证。实际行情、报告、证据检索应由 Squabble 自身工具提供。开发流程类技能不直接等价于投研能力，本次不将上游技能库批量复制进产品。

## 豆包补充

采用 [Fullstop000/doubao-cli](https://github.com/Fullstop000/doubao-cli) 的 Agent 会话接口，属于社区连接器，不是豆包官方 CLI。上游提供模型目录、推理强度及创建/查询/停止任务接口。2026-11-02 对 npm 0.23.2 在 Windows 的隔离配置验证确认：版本、headless 能力查询和未登录状态检测能够运行；这不等同于已登录的真实研究验收。上游 README 主要列 macOS/Linux，Windows 完整兼容性仍需真实账号测试。

任务应保存 `conversationId` 与 `runId`，取消时请求上游停止，超时或不确定接收不能自动重复提交。模型参数按上游当前约定使用目录中的精确名称。登录由用户在原生终端完成。
