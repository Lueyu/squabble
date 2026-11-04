# Squabble 竞争力分析报告

> 分析基于 2026-10-31 的 main 分支代码库与 GitHub 状态

---

## 一、项目现状概览

| 指标 | 数值 |
|---|---|
| 服务端 TypeScript 文件 | 256 |
| 客户端 TypeScript/TSX 文件 | 202 |
| 共享类型文件 | 14 |
| 桌面端 TypeScript 文件 | 8 |
| Python Agent 文件 | 10 |
| 数据库表 | 30 |
| API 模块 | 30 |
| MCP 工具 | 6 |
| i18n 键值对 | 569 |
| 服务端测试文件 | 66 |
| 桌面端测试文件 | 7 |
| 运行时依赖 | 34 |
| 开发依赖 | 88 |
| GitHub Stars | 4 |
| GitHub Forks | 0 |
| 已合并 PR | 15+ |
| Release 版本 | v2.2.0 |
| CI 检查项 | 7（Lint/Docker/Agent测试/三平台安装包/Release） |

---

## 二、技术先进性分析

### 2.1 架构决策评分

| 维度 | 评分 | 论据 |
|---|---|---|
| **领域建模** | ★★★★★ | 30 张表精细划分：核心业务(11)、多智能体(8)、用户+模拟盘(7)、通知(1)、配置(1)、导入(1)、council/research 扩展。ownership 一律 text 列 + owner-scoped 查询，行级隔离简洁且可审计。 |
| **多智能体流水线** | ★★★★★ | 五阶段（取数→辩论→批评→风控→评级）是**可验证的结构化推理**，与"一袋 prompt"式 LLM 调用有本质差异。每阶段状态写回 `agent_runs`，过程可回放、可审计。14 节研报版本化保留，输掉的多头/空头论点原文保存——这在同类产品中罕见。 |
| **MCP 服务器** | ★★★★☆ | 自实现 Streamable HTTP JSON-RPC 协议（零外部 SDK 依赖），6 工具覆盖查仓/行情/研报/下单/订单/导入。Per-agent 会话管理（日限额、只读/交易权限、审批模式）直接对标 Robinhood 2025-10 的 agent access 模型。扣一星：日限额预检是 10x sanity check，真正的逐单累计校验未接上。 |
| **投研讨论室（Council）** | ★★★★★ | 最先进的功能。7 种角色模板、2-6 人团队、逐轮辩论、A2A 协议委派本地 Agent、检查点/恢复/暂停。62 个 TS 文件，含 workflow-executor、workflow-store、workflow-resume、evidenceArchive。**这是项目最深的技术护城河**。 |
| **研究记忆与技能** | ★★★★☆ | research-memory（100 处记忆/存储/召回引用）+ research-skills（57 处版本/技能引用）+ research-tools（自动化研究工具）。允许 AI 团队拥有持久记忆、版本化技能、自动执行研究工具——组合起来形成了一个**自我进化的研究工作台**。 |
| **桌面应用** | ★★★★☆ | Electron 45.2 + electron-builder 26.18，三平台构建（Windows x64、macOS x64/arm64），内置 PostgreSQL，自动更新（electron-updater），双语安装向导。安装包 160-250MB，合理范围。 |
| **隐私与安全** | ★★★★★ | 自托管优先、零遥测、用户名+密码（无手机号/邮箱验证）、bcrypt 哈希、JWT access/refresh 双令牌、AES-256-GCM 加密供应商密钥、恢复码 SHA-256。settings 模块 76 处加密/解密引用。在开源投资工具中**安全设计最完备**。 |
| **国际化** | ★★★★☆ | react-i18next，569 键值对，中英双语，侧栏一键切换。服务端 X-Lang 头协商错误消息语言。CSV 列名匹配保留中文（兼容国内券商导出）。英文 README 零中文字符。扣一星：服务端 31 条错误消息目前全英文（通用但非双语）。 |
| **测试覆盖** | ★★★☆☆ | 66 个服务端 spec 文件 + 7 个桌面 spec。Council 有 15 个 spec 文件（对话、上下文、工作流、预算、恢复、工具）。但客户端 0 个 spec 文件，前端测试空白。 |
| **CI/CD** | ★★★★☆ | 7 项检查：Lint+typecheck、Docker build、Agent tests、三平台桌面安装包构建、Release 自动发布。分支保护、PR 必须过 CI。GitHub Release 自动上传 .exe/.dmg。 |

### 2.2 技术栈选择

```
前端:    React 19 + TypeScript 5.9 + Tailwind v4 + Radix UI + ECharts
后端:    NestJS 10 + Drizzle ORM + PostgreSQL 16
桌面:    Electron 45 + electron-builder 26 + electron-updater
Agent:   Python 3.12 (Typer/FastAPI, 独立可选)
认证:    bcrypt + JWT (access 2h / refresh 30d)
加密:    AES-256-GCM (provider keys)
协议:    MCP (自实现 JSON-RPC 2.0) + A2A 1.0 (JSON-RPC)
构建:    Vite 8 (rolldown) + SWC + Docker Compose
```

**评价**：全部主流、生产级技术栈。无小众依赖，无运行时安全隐患。React 19 + NestJS 10 + Electron 45 均为最新稳定版。

---

## 三、产品竞争力分析

### 3.1 竞品对比矩阵

| 能力 | Squabble | Ghostfolio | OpenBB | Portfolio Performance | clowder-ai | Robinhood |
|---|---|---|---|---|---|---|
| **定位** | 个人投资AI工作台 | 开源持仓追踪 | 金融数据终端 | Java桌面持仓管理 | 通用Agent编排 | 券商交易 |
| Stars | 4 | 9,647 | 75,064 | 4,144 | 3,654 | — |
| 持仓追踪 | ✅ 多市场 | ✅ | ✅ | ✅ | ❌ | ✅ |
| AI 研报 | ✅ 多智能体辩论 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 模拟炒股 | ✅ MCP+信号驱动 | ❌ | ❌ | ❌ | ❌ | ✅ (真实) |
| MCP 服务器 | ✅ 6 工具 | ❌ | ❌ | ❌ | ❌ | ✅ (官方) |
| 投研讨论室 | ✅ 7角色+A2A | ❌ | ❌ | ❌ | ✅ (通用) | ❌ |
| 桌面应用 | ✅ 三平台+自动更新 | ❌ (Web) | ❌ (Python CLI) | ✅ (Java) | ✅ | ✅ (App) |
| 截图导入 | ✅ OCR | ❌ | ❌ | ❌ | ❌ | ❌ |
| 通知推送 | ✅ 5 渠道 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 双语 | ✅ 中英 | ❌ | ❌ | ❌ | ✅ 中英日 | ✅ |
| 自托管 | ✅ Docker+桌面 | ✅ Docker | ✅ | ✅ 本地 | ✅ | ❌ |
| 零遥测 | ✅ | 部分 | ✅ | ✅ | ✅ | ❌ |
| 隐私优先 | ✅ 最严 | 部分 | ✅ | ✅ | ✅ | ❌ |
| 代码规模 | 490+ 文件 | ~200 | ~3000 | ~800 | ~400 | — |

### 3.2 核心竞争力（按护城河深度排序）

#### 🥇 第一护城河：结构化多智能体研究流水线

**论点**：这不是"把 prompt 发给 ChatGPT"，而是一条**可验证的五阶段推理管线**：

1. **取数阶段** — 证据带引用来源、时效性评分、相关性排序
2. **辩论阶段** — 多头/空头逐轮交锋，每条论点必须引用证据 ID
3. **批评阶段** — 必须至少推翻一条先验结论（防止确认偏误）
4. **风控闸** — 用户配置的策略规则作为硬门执行，违规则约束评级
5. **评级汇总** — PM 角色合并辩论与风控，给出评级+置信度+操作方案

**为什么别人难以复制**：需要同时做对 ①数据层（30 张表存全过程）②UI 层（14 节研报渲染 + 版本对比）③服务层（流水线编排 + 状态回写）。Ghostfolio 和 Portfolio Performance 没有 AI 管线的任何基础设施。OpenBB 有数据但无推理管线。clowder-ai 有 Agent 编排但无领域建模。

#### 🥈 第二护城河：投研讨论室（Council）

**论点**：这是**唯一一个让 AI 团队和人类在同一房间讨论投资决策**的开源产品：

- 7 种角色模板（研究员、质疑者、组合经理等）
- 2-6 人团队，每人独立性格和研究方向
- 逐轮对话 + 证据引用 + 批评修正
- 可委派任务给本地 A2A Agent（Codex CLI 桥接已内置）
- 检查点 / 恢复 / 暂停 / 预算控制
- 研究记忆持久化（AI 团队"记得"之前的讨论）
- 版本化技能（研究方法可迭代）

**竞品差距**：Robinhood 的 agent 只是"帮你下单"，不做研究讨论。clowder-ai 可以编排 Agent 但不懂投资领域。OpenBB 面向分析师而非个人投资者。

#### 🥉 第三护城河：Robinhood 式 MCP Agent 炒股（纸面）

**论点**：**逆向了 Robinhood 2025-10 agent access 的完整体验**，但在安全的模拟环境中：

- MCP 服务器（自实现协议，6 工具）
- Per-agent 日花费限额、只读/交易权限、审批模式
- 审批队列（pending_approval → 用户批准/拒绝）
- 订单流标注来源（🤖 Claude vs 👤 手动）
- 成交/风控/熔断推送通知

**为什么有价值**：Robinhood 的 agent 只面向美国市场。Squabble 支持美股+港股+A股，且完全开源可自托管。国内用户无法用 Robinhood agent，但可以用 Squabble 的模拟版体验同样的流程。

#### 第四护城河：隐私优先架构

**论点**：在所有投资工具中**隐私设计最激进**：

- 不收手机号、不收邮箱验证
- 零遥测、零埋点、零错误上报
- API key 只存用户自己的数据库（AES-256-GCM 加密）
- 截图 OCR 的 key 只存浏览器 localStorage（与 Finnhub token 同一模式）
- 无官方云服务、无同步服务
- 用户可以搜索代码中的 `fetch(`/`axios` 枚举全部出网路径

**竞品差距**：Ghostfolio 是自托管但不强调零遥测。OpenBB 可能有遥测。Robinhood 是闭源券商。

#### 第五护城河：桌面安装 + 自动更新

**论点**：**个人投资工具中唯一同时提供三平台桌面安装包 + Docker + 源码三种安装方式**：

- Windows x64 `.exe`（160 MB，含 PostgreSQL）
- macOS arm64/x64 `.dmg`（244/249 MB）
- electron-updater 自动更新
- 双语安装向导
- 内置 PostgreSQL，无需另装任何软件

**竞品差距**：Ghostfolio 只有 Docker。Portfolio Performance 是 Java 桌面但无 AI。clowder-ai 有桌面但非投资领域。

### 3.3 弱项与风险

| 弱项 | 影响 | 缓解策略 |
|---|---|---|
| **知名度极低**（4 stars） | 目前的最大瓶颈。产品已经成熟但没人知道 | linux.do 首发帖 + V2EX + 小红书 + X/Twitter 英文帖 |
| **前端测试空白**（0 client spec） | UI 回归全靠手动 | 补 Playwright E2E 测试 |
| **服务端错误消息仅英文** | 中文用户看到英文错误 | 接入 `srvMsg()` 双语助手（已建好框架） |
| **MCP 日限额未完全生效** | 纸面限额，非逐单校验 | 在 `placeOrder` 中做逐单累计检查 |
| **Python Agent 未集成下单工具** | MCP 是唯一 Agent 入口 | 给 Python agent 加 `place_paper_order` 工具 |
| **搜索/发现性** | GitHub topics 已优化，但缺 SEO | 写技术博客、提交 awesome-list |
| **社区规模** | 贡献者只有 1 人 | 标注 `good first issue`，写清晰 CONTRIBUTING |

---

## 四、战略建议

### 4.1 定位一句话

> **"Squabble 是开源的 Robinhood agent access + Bloomberg 研报工作台，但不碰你的真钱也不碰你的个人数据。"**

### 4.2 目标用户画像

| 用户 | 痛点 | Squabble 的答案 |
|---|---|---|
| 想试 AI 炒股但怕亏钱 | Robinhood 不对中国开放 | 模拟盘 + MCP Agent |
| 有持仓但看不懂研报 | 券商研报太长、无对立观点 | 多空辩论 + 批评者 + 14 节报告 |
| 关心隐私不想交数据 | 主流 App 收集一切 | 自托管 + 零遥测 + 用户名密码 |
| 不会装 Docker | 技术门槛高 | 下载 .exe 双击安装 |
| 用中英双语 | 大多数工具只有英文 | 569 键完整双语 |

### 4.3 推广策略建议

| 渠道 | 素材 | 预期效果 |
|---|---|---|
| **linux.do**（首发） | "我开源了一个让 AI 替你炒股的软件——模拟盘+研报+零遥测" | 核心种子用户，对标 clowder 的 LINUX DO 引流路径 |
| **V2EX 分享创造** | 同上 + 安装包链接 | 开发者群体 |
| **小红书** | 截图："让 5 个 AI 围着我的持仓吵架" + 深度研报截图 | 破圈到非技术用户 |
| **X/Twitter 英文** | "Open-source Robinhood-style AI agent trading. MCP + paper trading + zero telemetry." | 国际用户 |
| **GitHub Trending** | 需要 30+ stars 才有机会 | linux.do 引流后自然达到 |

---

## 五、总结

**技术先进性：★★★★☆（4.5/5）**

Squabble 在多智能体推理管线（五阶段+证据引用+批评者）、投研讨论室（A2A+持久记忆+版本化技能）、MCP 服务器（自实现协议+per-agent 控制）三个方向上**领先所有开源竞品**。30 张表的领域建模和 569 键的国际化体现了工程深度。前端测试空白和 MCP 限额细节是扣分项。

**产品竞争力：★★★★☆（4/5）**

功能完整度超越 Ghostfolio（+AI 研报）、Portfolio Performance（+AI+模拟盘+桌面三平台）和 OpenBB（+个人定位+双语+桌面）。与 Robinhood 相比：模拟盘 vs 真实交易是劣势，但隐私+自托管+多市场（US/HK/CN）+开源是 Robinhood 没有的优势。与 clowder-ai 相比：领域专精 vs 通用编排——**Squabble 更像一个产品，clowder 更像一个框架**。

**最大瓶颈是知名度（4 stars），不是产品力。** 下一步应该全力推广。
