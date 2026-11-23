# 03 · 产品历史方案与回顾（AI 迭代归档）

## 归档说明

本目录提炼自 `docs/superpowers` 与 `docs` 根目录下 AI 生成的产品方案、分析与审阅记录，对应原文件已删除。归档保留以下历史资产的核心信息：产品定位（简化版产品说明）、简化体验方案与交付、一次性分析、投委会（投研讨论室）人格设计、设置导航重设计、AI 股友 V4 设计、竞争力分析（2026-10-31 基线）与 review 处理记录。

> 说明：以下内容均为历史方案，不代表当前功能规范。当前使用方式以 [资产、报告与策略](../../assets-reports-strategy.md)、[频道](../../channel-workbench.md) 等现行文档为准。

## 产品定位与简化体验（Squabble 简单产品定位、简化体验方案与交付结论）

### 产品定位（审阅稿 2026-11-06）

Squabble 为个人投资者提供"一桌可以共同研究、相互质疑并跟踪判断结果的 AI 股友"：用户每天看懂自己的持仓、随时提出投资问题，并观察 AI 团队共同管理的模拟账户。目标用户是希望理解持仓、愿意与 AI 讨论、但不愿配置 Agent 工作流和交易规则的个人投资者。

已确定的产品方向（10 项）：

- 日常从今日开始（首页先回答持仓怎么样、发生了什么、有什么值得关注）
- 保留独立投研室（可自由讨论任何股票或投资想法）
- 保留真实多 Agent 特色（显示实际参与者、彼此回应、事实核查及观点变化）
- 自动运行一个 AI 对照盘（一次开启并确认范围后持续研究和模拟，不逐笔要求确认）
- 允许 AI 发现新股票（在用户确认的市场和风险范围内自主发现、研究、选择）
- 删除研报版本管理、删除策略配置流程
- 日常只管理一个 AI 账户（首次可复制真实持仓，后续独立运行，不自动跟随真实交易）
- 讨论不等于指令（聊天中的明确交易限制需通过简短确认卡应用）
- 暂停含义统一（暂停后停止全部自动模拟交易，包括自动保护性卖出）

三个主入口：**今日 / 投研室 / AI 投资**（设置固定放辅助位置；手机使用相同三入口）。不新增独立的策略中心、报告管理中心、Agent 团队管理中心或模拟实验中心。今日首页最多突出三条重要事项；每日默认按用户业务时区 **07:30** 准备当天摘要；投研室零表单开始讨论（自动携带股票/日报/决策上下文）；AI 讨论默认过程为"分别研究 → 相互质疑 → 必要时补查 → 汇总当前判断"，补查默认最多两轮；判断回访默认每天每账户最多 3 项。

AI 投资账户建议默认额度（供审阅的建议，非收益承诺）：单只股票仓位上限 10%、单笔新增买入上限 5%、当日累计新增买入上限 5%、当日普通买卖总额上限 20%、总仓位上限 90% 与最低现金 10%、当日亏损达 3% 后停止新增风险、仅做多不借款、每笔费用 5 bps 滑点 10 bps；研究预算未设置时每日最多 6 项自动研究任务，深度研究每次最多 3 位成员、2 轮补查、12 次模型/Agent 调用。新股发现每批最多 10 个候选、最多 3 个进入深度研究；新股自主买入至少需要两个可用独立执行来源。聊天限制首版支持：禁买某股、完全禁止卖出某股（明确覆盖自动止损）、临时停止加仓、调整单股上限、调整最低现金、调整允许市场。收益默认对照"AI 账户 vs 起点持仓保持不动"，市场基准为次级参考。验收目标：至少 5 位未参与设计的试用者，至少 4 位 10 秒内找到持仓概况、30 秒内从股票发起问题（需实际试用，不以开发者自测冒充）。

### 简化体验开发计划（2026-11-06，用户已确认开发）

- **目标**：改造为"今日、投研室、AI 投资"三入口；删除用户需要管理的版本、策略发布和实验流程。
- **技术栈**：React 19、React Query、NestJS、Drizzle/PostgreSQL、现有本地 Agent 适配与 node:test；只实施 Web，桌面打包和标准 A2A 远程端点不属于本轮。
- **基线**：已合并提交 `8e04fbc`；对应产品说明 `docs/squabble-simple-product.zh-CN.md`。
- **分三阶段交付**：A 简单阅读与真实讨论；B 持续授权与自主模拟；C 回访、兼容切换和端到端验收。三阶段全部验收才算完成，A 阶段不能宣称已完成自主投资。
- **新增表**（迁移 31_simple_experience.sql、32_autonomous_investment.sql，实施时用下一个空闲序号）：experience_preferences、research_current_views、council_independent_submissions、investment_policies、investment_cycles、investment_constraint_proposals、research_followup_jobs；扩展 strategy_mandates/strategy_signals 与 Council 公开消息。
- **关键契约**：InvestmentStatus（not_started / needs_information / needs_confirmation / running / paused / attention_required）、InvestmentConstraint（no_buy / no_sell / no_increase / position_cap / cash_floor / markets）、ResearchContext、DebateOutcome；独立执行来源按"连接身份+实际运行供应商/模型"解析，不按头像或角色数计算。
- **新接口**：GET /api/today、/api/research/current、/api/research-conversations 系列、/api/ai-investment 系列（preview/start/pause/resume/constraints/decisions/history/restart）；约束提案有效期 15 分钟；所有写接口校验 requestKey 幂等。
- **安全边界**：统一锁顺序 owner 锁 → account 锁 → policy 锁；自动研究周期 5 分钟租约；自动发现/组合研讨/单股深研/回访共享每日自动任务预算（每任务最多 12 次调用，默认每日 6 个自动任务）；发现每批最多 10 候选、3 个深研名额；已迁移新账户拒绝任何无父授权绑定的自动订单。

### 交付记录（simple-experience-delivery）

- 基线 `8e04fbc`，开发分支 `codex/simple-experience`；服务端 `SQUABBLE_SIMPLE_EXPERIENCE=true` 开启新入口，**默认关闭**；本地验收实例使用独立空数据库 `http://127.0.0.1:3190`。
- 升级验证：从 8e04fbc 原始基础 SQL 建立旧库（保留 7 股虚构持仓和启用中的 12345 模拟现金账户），新旧库分别重复应用迁移 31–33 两次，**1081 列结构一致**，旧持仓/现金/开关状态不变，未自动生成父授权。
- 最终自动化检查：服务端全量回归 **677 通过 / 0 失败 / 0 跳过**；最新投资/发现/预算/迁移专项 **23 通过**；客户端回归 **224 通过**；本地 Agent **167 通过**（1 项 POSIX 平台场景在 Windows 跳过）；开发启动 **8 通过**（1 项跳过）；研究记忆评估 passed（**99 项**操作回归通过）；Lint、类型、Stylelint、Web 生产构建、中英文 390px 及 1440px 浏览器均通过。
- 实际限制：首版只在原币可用现金内交易，不自动换汇；普通股票须通过供应商身份和报价核验，ETF 还需可靠发行人资料证明普通、非杠杆、非反向（默认发行人核验只覆盖 **SPY**）；服务器离线不补造交易；收益默认对照相同起点持仓保持不动。
- **未完成项**：五位未参与设计者的真人可用性试用**尚未进行**（目标至少 4 位 10 秒找到持仓概况、30 秒从股票提问）；浏览器自动化与 AI 审查均不冒充真人通过。

## 一次性分析（One-click analysis and market overview）

- **目标**：一键运行组合/单股分析并展示市场概览，作为早期分析/Dashboard 设计（已被现行产品指南取代；分析 API 与读取器仍保留）。
- **方案要点**：无 API key 时用免费内置的确定性证据与风控审查，明确标注 Basic analysis，不虚构 AI 辩论或价格目标；配置模型 key 时走现有 multi-agent LLM workflow，供应商失败如实报告；默认金融数据为公开免 key 行情，Finnhub 为可选增强；从 Daily Analysis 直接运行，提交时持久化所选语言，展示进度、失败与报告链接；报告展示公开分析轨迹（来源、时间戳、完成/跳过步骤、简明论证、风控检查），不请求或存储隐藏模型推理；Dashboard 展示市场指数变化和由可用指数收益推算的"估算市场情绪"（带来源日期、覆盖、过期/错误状态与公式说明）。
- **未实施边界**：验证只使用 demo 或隔离测试数据、mocked LLM 响应、真实免 key 行情冒烟检查；不涉及券商订单、凭证披露、模型安装或付费 API 调用。

## 投委会人格与设置导航（设计结论）

### 投研讨论室角色与对话设计（council-personas-design）

- 7 种角色模板（本地 SVG 头像，柔和纸感、绿色多头、珊瑚色质疑者、金色归纳者）：价值研究员（小牛/苔绿）、成长研究员（小兔/薄荷绿）、风险审视者（小熊/珊瑚）、市场观察员（小猫/雾蓝）、事件研究员（狐狸/杏色）、宏观研究员（鲸鱼/淡紫）、讨论主持人（猫头鹰/暖金）。角色名称始终可见，颜色不单独承担身份含义；用户选择的 avatar 优先，旧记录按 researcher/challenger/manager 回退。
- 多空配色跟随界面语言：中文为**红牛、绿熊**，英文为**绿牛、红熊**（上表为英文默认色），初次加载、刷新、语言切换与深色模式均遵循。
- 交互：研究观点左侧排列、风险模板右侧，主持人消息加顶部强调线；「追问这条观点」显示可取消的引用预览，消息总长上限 **2000 字**；「复制观点」不含隐藏模型内部推理；三个快捷提问只填草稿不自动发送；输入框最高 **160px**；发送失败全部保留草稿，请求期间修改任一项成功回调保留新草稿；手机成员条横向滚动。
- 验证：前端类型检查、构建、完整前端测试与 lint；浏览器用隔离示例会话检查浅/深色、手机布局、复制、快捷提问、失败保留草稿等，测试接口由浏览器拦截，不写入真实讨论。

### 设置导航重设计（2026-11-03，settings-navigation-design）

- **目标与设计**：把不断增长的设置 feed 替换为持久次级导航（受 Clowder 截图启发，沿用 Squabble 主题 tokens）。分组：Research（模型连接与默认 API、本地 agents、市场数据、用量/预算、策略规则）、Personal/system（外观、账户安全、更新）、Help（配置指南）。桌面主导航仅在设置打开时变为可访问的 icon rail；次级侧栏常驻可见；移动端保留应用抽屉 + 分类选择器。
- 每个 section 有 `/settings/<section>` URL，`/settings` 打开 models；旧 budget 与 local-agent hash 链接重定向到新 section；首次访问挂载 section 并在设置期间保留（跨分类导航保留未保存表单草稿）；不将草稿或密钥持久化到浏览器存储；更新页提供显式 loading/retry/unavailable 状态。
- **验证结论**：`type:check:client` 通过；`test:client` **78 个测试通过**（含 legacy 路由、URL 规范化期间保留面板、非活动模型对话框草稿保留）；ESLint/Stylelint 通过；`build:web` 通过；Playwright 对隔离后端验证全部 9 个分类、历史导航、直达/legacy 链接、刷新、双显示模式下 4 个主题、英文导航与移动抽屉；**36 个 category/viewport 组合**（360/390/768/1024px）无水平溢出，桌面另查 1440px；截图保存在被忽略的 `output/playwright/settings-*-final.png`。独立只读代码审查无剩余阻塞项。

## AI 股友 V4（Squabble V4 Implementation Plan，2026-11-10）

用户已于 2026-11-10 批准 Figma 设计并明确授权实施（无需再次设计审批）。

- **目标**：实现已批准的 AI 伴侣工作区：可靠导航、独立管理的模拟盘、持久多轮策略澄清、可读的组合每日事实，以及可发现的数据/记忆/集成工具。
- **技术栈**：React 19、React Router 7、TanStack Query、shadcn/Radix、现有 ECharts、TypeScript、NestJS 10、Drizzle/Postgres 16。保留现有 owner/account、账本、版本与显式应用契约。
- **设计来源与基线**：Figma 文件 `0dw4pcW4fkotFzqL7RxHLG`（page `84:1221`；overview `87:1392`、strategy interview `90:2143`、daily `91:2079`、memory `93:3868`、data `93:3165`）；隔离实施分支 `codex/ai-friend-v4` 起点 `98f073e`（保留之前两个已批准 portfolio workspace 提交）；现有 main 为 `9e2d83a`。
- **导航**：八个根路由 `/`、`/paper`、`/daily`、`/research`、`/holdings`、`/data`、`/memory`、`/settings`，保留所有既有 URL；路由描述符含标题/所属根/父级/类型；按 React Router location key 记录内容滚动并恢复 POP；桌面八节侧栏 + 移动五栏导航 + 可搜索目的地对话框。
- **要点**：Overview 持久化所选动物伙伴身份（未分配账户邀请选择，绝不从名字或索引推断人格）；四个起始点（真实持仓/虚拟现金/指定模拟盘当前持仓与现金/自定义初始持仓），拷贝快照在源变化后保持冻结；持久策略访谈（迁移 `46_strategy_interviews.sql`）冻结账户目标、保留原始话语与答案来源、建议与确认分离；`price_lt`/`price_gt` 与显式 once/per-trading-day 频率经规范化、预览与最终执行守卫严格校验（旧规则默认 once）；每日事实与研究（`GET /api/daily-workspace?date=YYYY-MM-DD` 只读事务，真实成交时间戳/费用/精确日期快照，缺失保持未知）；总体每日研究只经显式 `POST /api/daily-workspace/research` 触发；伙伴契约迁移 `47_portfolio_companions.sql`；显式同任务恢复（recovery / resume-report），绝不重放已接受的独立工作。
- **最终验证**（记录于 `docs/v4-delivery.md`）：客户端 **406/406**、服务端 **972/972**（一次性数据库）、本地 agents **180 通过 + 1 个 Windows 跳过**、architecture **5/5**、context **15/15**、lint/build/context/wiring 通过；最后整体/native 恢复变更独立 **20/20** 通过（覆盖七个恢复场景）。浏览器验收在隔离预览上用虚构 API fixtures 或专用 UI 数据库完成；线上个人服务 3190 端口未受影响。

## 竞争力分析（2026-10-31 基线）

分析基于 2026-10-31 的 main 分支代码库与 GitHub 状态。

### 项目现状指标

| 指标 | 数值 |
| --- | --- |
| 服务端 TypeScript 文件 | 256 |
| 客户端 TypeScript/TSX 文件 | 202 |
| 共享类型文件 | 14 |
| 桌面端 TypeScript 文件 | 8 |
| Python Agent 文件 | 10 |
| 数据库表 / API 模块 | 30 / 30 |
| MCP 工具 | 6 |
| i18n 键值对 | 569 |
| 服务端 / 桌面端测试文件 | 66 / 7 |
| 运行时 / 开发依赖 | 34 / 88 |
| GitHub Stars / Forks | **4 / 0** |
| 已合并 PR / Release | 15+ / v2.2.0 |
| CI 检查项 | 7（Lint/Docker/Agent 测试/三平台安装包/Release） |

### 技术栈

前端 React 19 + TypeScript 5.9 + Tailwind v4 + Radix UI + ECharts；后端 NestJS 10 + Drizzle ORM + PostgreSQL 16；桌面 Electron 45 + electron-builder 26 + electron-updater；Agent Python 3.12（Typer/FastAPI，独立可选）；认证 bcrypt + JWT（access 2h / refresh 30d）；加密 AES-256-GCM（provider keys）；协议 MCP（自实现 JSON-RPC 2.0）+ A2A 1.0；构建 Vite 8 (rolldown) + SWC + Docker Compose。评价：全部主流、生产级技术栈。

### 架构评分结论

| 维度 | 评分 |
| --- | --- |
| 领域建模 | ★★★★★（30 张表，ownership 一律 text 列 + owner-scoped 查询） |
| 多智能体流水线 | ★★★★★（五阶段：取数→辩论→批评→风控→评级，状态写回 agent_runs 可回放） |
| MCP 服务器 | ★★★★☆（自实现 Streamable HTTP JSON-RPC，6 工具；日限额预检是 10x sanity check，逐单累计校验未接上） |
| 投研讨论室（Council） | ★★★★★（7 角色、2-6 人团队、A2A 委派本地 Agent、62 个 TS 文件；**最深技术护城河**） |
| 研究记忆与技能 | ★★★★☆（research-memory 100 处引用 + research-skills 57 处 + research-tools） |
| 桌面应用 | ★★★★☆（Electron 45.2 + electron-builder 26.18，三平台构建，安装包 160–250MB） |
| 隐私与安全 | ★★★★★（自托管优先、零遥测、用户名+密码、bcrypt、JWT 双令牌、AES-256-GCM、恢复码 SHA-256） |
| 国际化 | ★★★★☆（569 键中英双语；服务端 31 条错误消息目前全英文） |
| 测试覆盖 | ★★★☆☆（66 服务端 spec + 7 桌面 spec；**客户端 0 个 spec，前端测试空白**） |
| CI/CD | ★★★★☆（7 项检查，PR 必须过 CI） |

### 竞品对比（Stars，2026-10-31）

Squabble **4**；Ghostfolio **9,647**；OpenBB **75,064**；Portfolio Performance **4,144**；clowder-ai **3,654**；Robinhood —（闭源券商）。

### 五条护城河（按深度排序）

1. **结构化多智能体研究流水线**：可验证的五阶段推理管线（取数带证据引用/时效性/相关性 → 辩论逐轮引用证据 ID → 批评至少推翻一条先验结论 → 风控闸按用户策略规则硬执行 → PM 评级汇总），需同时做对数据层（30 表）、UI 层（14 节研报+版本对比）、服务层（编排+状态回写）。
2. **投研讨论室（Council）**：唯一让 AI 团队和人类在同一房间讨论投资决策的开源产品；7 角色、2-6 人、逐轮辩论、A2A 委派 Codex CLI、检查点/恢复/暂停、研究记忆持久化、版本化技能。
3. **Robinhood 式 MCP Agent 纸面炒股**：自实现协议 6 工具、per-agent 日限额/只读/交易权限/审批模式、订单流标注来源（🤖 Claude vs 👤 手动）、成交/风控/熔断推送；支持美股+港股+A股且开源可自托管（国内用户可用）。
4. **隐私优先架构**：不收手机号/邮箱验证、零遥测零埋点、API key 仅存用户库（AES-256-GCM）、OCR key 只存 localStorage、无官方云服务、可搜索 `fetch(`/`axios` 枚举全部出网路径。
5. **桌面安装 + 自动更新**：Windows x64 `.exe`（160 MB，含 PostgreSQL）、macOS arm64/x64 `.dmg`（244/249 MB）、electron-updater 自动更新、双语安装向导。

### 弱项与总结

弱项：知名度极低（4 stars，最大瓶颈）、前端测试空白（0 client spec）、服务端错误消息仅英文、MCP 日限额未完全生效、Python Agent 未集成下单工具、SEO/搜索性不足、社区贡献者仅 1 人。

定位一句话："Squabble 是开源的 Robinhood agent access + Bloomberg 研报工作台，但不碰你的真钱也不碰你的个人数据。"

**总结结论：技术先进性 ★★★★☆（4.5/5）；产品竞争力 ★★★★☆（4/5）；最大瓶颈是知名度（4 stars），不是产品力。**

## Review 处理记录（Agent 工具体系审查处理，2026-11-11）

用户已授权实施、采纳审查意见、通过测试后合并及本地部署。本文记录契约修正，不代表真实云连接或全部工作包已经验收。

采纳的契约（4 个审查组）：

- **状态与恢复**：result_received 可归档前取消；failed 仅从完整已存响应本地重解析并追加解析审计；provider_unknown 可关闭 settled_unknown，旧预留仍占用，晚到账单仅幂等修正。实施位置：shared/research-runtime.interface.ts、runtime-journal.service.ts、runtime-recovery.service.ts。
- **审批与批次**：审批专属 runtime dispatch（SDK execute/toolApproval 关闭），拒绝 provider-executed writes；编辑预览 waiting_approval 自环，新 revision/hash 清除旧确认且不调用模型；混合批次 read 先运行、write 停放，恢复不重读。位置：common/agent-contract.ts 纯规则、research-runtime.service.ts、ai-sdk-model.adapter.ts、tool-actions.service.ts。
- **模型协议与预算**：每 step 一个模型 HTTP/dispatch；内部模型请求独立 child dispatch；JSON-action 非法 JSON/schema、未知工具、非法参数、重复 ID 形成结构化 tool-result 与稳定 ID，下一 step 受显式上限及预算控制；available=limit-settled-inflight，未知预留不退款。位置：common/agent-contract.ts、runtime-dispatch.service.ts、llm-budget.service.ts、tool-budget.service.ts。
- **冻结事实与时间**：datasetVersionIds + 每版内容 hash + 持仓/现金/来源私有 payload 快照，整体 frozenInputHash；原 asOf 保持兼容，新业务 dataAsOf 未知仍为 null。位置：council-tool-runtime.service.ts、data-dataset.service.ts。

**明确不采纳的含义**（会破坏未知费用、调用唯一性、审批边界或复算语义）：把 settled_unknown 当确认失败并释放预算；把解析失败变为重新发送；确认写入时重跑已完成只读工具；由 SDK 与 runtime 同时拥有审批；错误触发自动换供应商付费；只冻结证券代码而不冻结事实。

**验证**：P0 离线契约先观察 20 个用例因未实现失败，再实现为 **20/20 通过、无 skip**（命令：`node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/research-runtime/runtime-contract.spec.ts`）；该证据只覆盖共享契约与纯规则，实际 HTTP 次数、数据库并发、供应商能力与真实写入仍须对应工作包独立验收。实现期另要求检查来源政策收紧、迟到解析任务 ID、孤儿产物、零值用量占位、额外 total tokens、计算撤权/清理及浏览器可引用证据；具体测试结果以最终交付验证记录及 PR CI 为准。

## 源文档

本目录提炼自以下原文件（相对仓库根，均已删除）：

- `docs/squabble-simple-product.zh-CN.md`（产品审阅稿，2026-11-06）
- `docs/superpowers/plans/2026-11-06-squabble-simple-experience.md`（简化体验开发计划）
- `docs/simple-experience-delivery.md`（简化体验交付记录）
- `docs/one-click-analysis-plan.md`（一次性分析与市场概览方案）
- `docs/council-personas-design.md`（投研讨论室角色与对话设计）
- `docs/settings-navigation-design.md`（设置导航重设计，2026-11-03）
- `docs/superpowers/plans/2026-11-10-ai-friend-v4.md`（AI 股友 V4 实施计划）
- `docs/competitive-analysis.md`（竞争力分析报告，2026-10-31 基线）
- `docs/superpowers/review-resolution.md`（Agent 工具体系审查处理，2026-11-11）
