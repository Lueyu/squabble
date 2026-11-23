# 02 · 研究与闭环设计历史（AI 迭代归档）

> 状态：历史归档（Historical）。本目录记录 2026-11-04 至 2026-11-11 期间由 AI 开发流程产出的研究、闭环设计与本地验收文档的设计结论。
> 这些文档记录的是当时的本地验证结果，不代表当前 checkout 的验证状态；当前开发入口见 [docs/README.md](../../README.md)。

## 归档说明

本目录统一提炼 `docs/superpowers/` 下的 specs / plans / notes，以及 `docs/` 下的 `*-delivery`、`*-validation` 与研究路线图。源文档已在 [docs/README.md](../../README.md) 的「Retained workflows and history · 保留流程与历史记录」中标记为历史记录，不再作为当前开发入口；本 README 是它们的统一归档摘要，用于追溯设计结论、接口契约与真实验收数字。

归档保留六条主线：

1. **研究—策略闭环**（2026-11-05）：报告 → 讨论 → 策略 → 分层决策 → 模拟执行 → 复盘。
2. **研究体验恢复**（2026-11-06）：导入即分析、投研室固定比例与失败恢复。
3. **简单模拟闭环**（2026-11-07）：日报 → 策略复制 → 模拟执行 → 频道反馈 → 策略管理。
4. **研究记忆路线图**（2026-11-04 更新）：M1–M7 记忆与检索能力。
5. **开发 skill**（2026-11-07）：仓库自有的 contributor skill 与五张架构图。
6. **Assistant 可维护性**（2026-11-09）：模块边界收口与可读性重构。

能力后端验证（2026-11-11）作为补充证据并入第 5 节。

---

## 研究—策略闭环（2026-11-05）

来源：`superpowers/specs/2026-11-05-research-strategy-loop.md`（427 行，已批准）、`superpowers/plans/2026-11-05-research-strategy-loop.md`、`research-strategy-loop-validation.md`。

### 设计目标

把日报/单股报告、场景研讨、期间策略与 AI 模拟盘串成一条可追溯链路：**看到变化 → 引用报告讨论 → 修订观点 → 发布策略 → 分层决策与模拟执行 → 用结果继续研究**。确定性规则直接执行模拟交易；不确定信号交给 AI 补判；高风险或大仓位进入多 Agent 研讨。每次执行都绑定当时的报告版本、策略版本与行情数据版本。基线为 `D:/stock/daily-portfolio-analysis`（`D:/stock/code` 更旧、不互通）。

### 八项已批注决定（D1–D8）

| 编号 | 决定 |
| --- | --- |
| D1 | 保留三个入口（研究报告 / 投研室 / AI 模拟盘），由同一研究主题串联；在 daily-portfolio-analysis 上实现 |
| D2 | 报告版本不可覆盖；讨论可生成修订草稿或假设分支，再采纳为主结论 |
| D3 | 月度/自定义期间策略约束每日执行计划；策略内候选自动分流 |
| D4 | 高风险升级优先于普通规则；预先授权的保护性退出保留快速通道 |
| D5 | 从真实盘复制完整起点创建新模拟实验；原实验保留 |
| D6 | 首版支持多币种起点与现金账；保留原成本，但模拟收益从复制时净值开始 |
| D7 | 报告关键依据被证伪 → 暂停受影响的新开仓并补研；保留既定保护退出 |
| D8 | 三阶段验收：报告与讨论 / 策略与路由 / 真实盘起点与复盘；全部完成即目标达成 |

### 阶段流转与三阶段验收

- **阶段一 · 报告和讨论连通**：统一报告版本引用、研究输入快照、从报告携带材料进入场景、段落引用、修订差异、采纳与简单分支；本地 Agent 提交契约。验收：旧日报永远打开当时的单股版本；从报告进讨论无需手动复制；推翻结论后原报告仍可查；并行修订不覆盖；任务重试不产生重复报告。
- **阶段二 · 策略与分层决策**：期间策略与每日计划分离；从讨论生成可编辑策略草稿；发布 → 规则直达 / AI 补判 / 多 Agent 研讨；版本切换、到期、保护退出、预算与决策卡可追溯。验收：低风险规则不调用模型；高风险命中规则仍研讨；硬拒绝不能被任何 Agent 覆盖；保护退出不等候加仓研讨；慢结论返回后用新行情重校验；重复触发只成交一次；策略替换后旧候选无法成交。
- **阶段三 · 真实盘起点与期间复盘**：完整起点快照、多币种现金、独立模拟实验、期初账本、同起点对照；日报/月度/自定义期间复盘回灌。验收：复制前后股数与原币现金一致，起点净值可对账；复制不生成买入、不重复扣现金；历史浮盈不计入 AI 新收益；重复导入请求不创建重复实验；真实盘变化不覆盖模拟；暂停/到期不丢保护；离线恢复不补造历史成交。

### 证据 / 记忆契约

- 三个版本概念必须分开：**讨论修订号 / 报告版本 / 策略版本**。
- 引用 = 报告整篇、章节、论点及原始证据；多 Agent 引用同一条新闻合并为一个证据来源。
- 时效：观点更新 → 提示策略复核（现行策略按固定版本运行）；关键事实被纠正或关键假设失效 → 暂停受影响规则的新增风险 + 补研任务，保护退出继续。
- 时间至少保存：事件发生、数据首次可用、系统采集、研究截至、生成、生效。

### 决策路由（快慢路由）

| 优先级 | 输入 | 行为 |
| --- | --- | --- |
| 0 | 实验停机、版本失效、报价不可用、不可交易、资金或可卖数量不足 | 阻止交易或等待数据；不调用模型争取放行 |
| 1 | 预先授权的保护性减仓或止损，且执行条件有效 | 快速执行保护，不等待多 Agent |
| 2 | 普通交易触及软风险阈值、大仓位、重大事件或关键研究分歧 | 直接送研讨室，即使规则完全确定 |
| 3 | 低风险、条件可计算、输入完整、规则在授权范围内 | 无模型调用，直接进入统一执行校验 |
| 4 | 授权范围内，但需要有限的语义判断或证据消歧 | 单 Agent 补判；不能解决则等待或升级研讨 |

软升级阈值（设计默认，非投资建议）：成交后单股敞口达该股硬上限的 **80%**，或单次新增风险的仓位变化达组合净值的 **3%** → 研讨。单 Agent 只能输出：通过 / 等待 / 否决 / 升级 + 理由 / 引用证据 / 有效期。所有路径进入同一确定性执行器，模型不直接操作现金或持仓。

### 策略模型

- 策略两层：**期间策略**（目标、有效区间、投资范围、资金与风险边界、关键假设、基准、允许自动调整范围）+ **每日执行计划**（受期间策略约束）。
- 策略卡 10 字段：目标与周期 / 适用账户 / 可投资范围 / 仓位约束 / 进入与调整 / 数量计算 / 退出与保护 / 决策路由 / 资料与依据 / 运行与预算。
- 策略状态：草稿、已发布待生效、运行中、暂停新增、已到期、已替代。

### 模拟盘与数据对象

- 复制创建独立模拟实验，写入期初持仓和期初现金；**不是买入**，不扣第二次现金、不产生开仓手续费、不把真实订单复制成模拟成交；多币种现金账。
- 起点数据 8 类处理规则：现金完整 / 未提供现金 / 成本缺失 / 价格或汇率缺失 / 源持仓预览后变化 / 不支持资产 / 原币现金与汇率 / 重复点击。
- 收益口径：同起点按策略运行 vs 同起点保持原持仓对照 vs 用户选择市场基准（相同起止时间、币种、口径）；历史真实成本与模拟起点市值两套口径分开，已有浮盈不算 AI 新赚的钱。
- 8 个数据对象：研究主题 / 讨论 Thread / 报告及版本 / 研究输入快照 / 期间策略及版本 / 每日执行计划 / 模拟实验及起点 / 决策记录。
- 首版不纳入：券商真实自动下单、复杂衍生品、完整订单簿仿真、任意策略自动合并、自动优化模型。

### 实施与验收结论

- 方案：在 main `81bfbfb` 上扩展，保留 Council / 研究记忆 / 策略信号 / paper 账本；新增中性 `ResearchDocumentsModule`，扩充 Council 场景/引用/分支，期间策略围绕每日计划，独立实验起点与现金，所有自动化路径终点为确定性 paper 校验。
- 迁移：`26_research_documents.sql`、`27_research_threads.sql`、`28_simulation_experiments.sql`、`29_strategy_mandates.sql`（26–30 注册到启动 / Docker / CI）。
- 契约：`ReportReference={versionId,sectionId?,excerpt?}`、`ReportSource={type:'daily'|'deep'|'portfolio'|'council',id}`、`resolveReferences(owner,references):ResolvedReportReference[]`、`importSource(owner,source):ResearchDocumentVersion`；版本字段 `id/reportId/version/title/kind/ticker/content/sections/dataAsOf/availableAt/createdAt/snapshot/source/parentVersionId`。
- 导航：`/analysis/reports/:versionId`、`/council?referenceVersionId=...&scene=portfolio_daily|stock`、`/paper?sourceReportVersionId=...&draft=1`。
- 技术栈：React 19 / NestJS / Drizzle / PostgreSQL / `node:test`（tsx）/ React Query；web-only（桌面打包暂停）。
- 验收（2026-11-05，基线 main `81bfbfb`，分支 `codex/research-strategy-loop`，Windows / Node 24.16.0 / npm 11.13.0 / PostgreSQL 18.6；CI 为 Node 22 / PG 16，远端 CI 未运行）：后端含真实 PG **641/641**、前端 **201/201**、本地 Agent **167 通过 + 1 平台条件跳过**、开发进程 **8 通过 + 1 POSIX 跳过**、研究记忆评估 **99/99**；ESLint / 类型 / Stylelint 通过；Web 生产构建通过（Vite 提示较大前端包）；新库 + 旧库迁移重复执行通过，**956 项**表列定义一致；虚构现金 1234.56 / 股份 8 / 成本 90 保留。
- 浏览器验收（虚构 AAPL）：报告 V1 → 引用章节 → 组合讨论 → 阶段总结 → 修订 V2 → 差异 → 采纳（V1 仍可打开）；从报告起草策略（规则不足不能发布）；预览真实盘起点 10 股 / 5,000 USD → 创建独立实验（数据库确认 0 订单 0 交易，原实验保留）；精确策略链接显示原账户只读；源持仓 10→20 股出现起点变化提示，模拟仍 10 股 / 5,000 USD，390px 无水平溢出。

---

## 研究体验恢复（2026-11-06）

来源：`superpowers/specs/2026-11-06-research-experience-recovery.md`、`superpowers/plans/2026-11-06-research-experience-recovery.md`、`research-experience-recovery-delivery.md`。

### 背景：五类故障

1. **Codex 报告格式错误**：09:34:13–09:39:37 约 324 秒的合法 JSON 被整份拒绝——`response.details` 是 5 段文本对象，应用却要求字符串。修复方向：统一输出契约 + 对显式旧格式无损转换 + 保留材料允许重解析。
2. **OpenCode 执行失败**：约 1.6 秒失败，未指定模型；本地默认 `deepseek-v4-flash` 被解析为提供商名称、模型 ID 为空，完整标识为 `gateway/deepseek-v4-flash`。修复方向：派发前发现空模型 ID、尊重显式配置、提供修复入口；「已登录」≠「一定可执行」。
3. **失败提示笼统**：所有失败都显示「没有可用 AI」。需分开：连接缺失 / 配置问题 / 运行失败 / 内容待整理。
4. **长时间无反馈**：任务讨论事件为空、无生命周期。所有话题需要任务生命周期 + 逐成员状态 + 进度。
5. **首页看不到可用分析**：导入不启动分析、更新按钮隐藏、基础模板可占「已完成」状态、摘要截取内部数据正文。修复方向：打通入口、区分数据与研究、用户可读摘要。

### 恢复方案（三阶段十四项）

- **阶段一 · 研究能够完成并可恢复**：统一执行就绪与 OpenCode 配置传递（`execution-readiness.ts`）；统一输出契约（`council-output.ts`，`details` 5 段 `Record<string,string>` → 分节文本并保持原文顺序）；全话题生命周期与安全诊断（`research-journal.ts`，`queued/running/completed/failed/cancelled`）；原讨论内重解析与逐成员重试（`council-recovery.service.ts`）；首轮受控并行与逐位结果（`council-member-attempts.service.ts`，最多 2 并发、第三位排队）。
- **阶段二 · 首页与投研室易用**：固定比例聊天外框（≥1280 CSS px 时为主内容可用宽度的 **92%** 居中、两侧各 4%；<1280 为 100%；不用 `92vw`）；股友状态、消息与恢复操作（`sending/accepted/queued/running`）；今日主分析区域与可靠摘要（`report.summary` / 风险 / 关注事项，`dailyLedgerFacts` 不出现在摘要首部，`facts_only ≠ AI 研究完成`）；导入确认与分析请求衔接（「确认持仓并开始分析」/「仅保存持仓」，持仓 + 导入回执 + `research_analysis_requests` 同一事务，回执 ID 幂等，一份回执最多一个分析任务）。
- **阶段三 · 多图导入与真实验收**：持久批次与逐图恢复（`import-batches.schema.ts`，原图 24 小时到期、运行项请求取消后等终止确认）；识别部分结果与逐步核对（十行中一行坏字段仍有九行可核对，不 0 填缺失数量/成本）；跨图合并、差异预览与增量事务（按市场 + 证券身份合并，重叠行不累加，7/10 先保存后 3 张补齐）；识别性能（能力缓存配置 / 登录 / 运行错误后失效，默认每组最多 2 张，每行返回来源图片标识，不承诺固定秒数）；集成验收、迁移与交付（有界真实联调：两位成员各一次初稿不自动重试，十张虚构截图两路径各一次识别最多 20 次调用）。

关键契约（计划）：

```ts
type ResultAcceptance = 'pending' | 'accepted' | 'rejected';
type FailureStage = 'preflight' | 'dispatch' | 'runtime' | 'parse';
type RecoveryAction = 'check_existing' | 'reparse_existing' | 'retry_member' | 'fix_configuration';
interface SafeFailure {
  code: string;
  stage: FailureStage;
  fieldPath?: string;
  expectedType?: string;
  actualType?: string;
  exitCode?: number;
  recoveries: RecoveryAction[];
}
```

`SafeFailure` 仅白名单，凭据 / 原始 stderr / 完整 prompt / 持仓正文不进诊断；旧任务显示「旧任务未记录详细原因」。API：`GET /api/research-execution/readiness`、`POST /api/research-conversations/:id/recovery`、`POST /api/import/batches`、`GET /api/import/batches/:id`、`POST /api/import/batches/:id/retry`、`POST /api/import/batches/:id/preview`、`POST /api/import/batches/:id/commit`（原子提交、幂等回执）。迁移：`34_research_execution_recovery.sql`、`35_import_batches.sql`、`36`（分析待派发请求及冻结输入）。

### 交付结果

14 项任务全部交付（2026-11-06，Asia/Shanghai）。真实本地联调（虚构持仓，不碰真实账户）：Codex 新初稿 1 次调用约 **65 秒**通过应用校验；OpenCode 新初稿 1 次调用约 **82 秒**返回完整顶层研究字段，兼容修复由保存文本离线验证、未追加模型调用；用户原 Codex 对象型 `details` 用真实结构离线复现。十张同账户虚构分页截图：**29 个可见行 / 20 个唯一证券 / 9 处跨页重叠**，每张最多 1 次调用、两路径合计 **20 次**识别调用、失败不自动补跑。性能：每张重新探测环境基线为总耗时 **330.640 秒** / 首批结果 **34.270 秒** / 唯一证券完整正确 **18/20**；复用检测缓存为 **278.657 秒** / **38.497 秒** / **20/20**（数量、成本、现价与样本一致，重叠行未累加）。约 16% 总耗时差不能全部归因于缓存；主要体验改善是逐张可见、可先核对、失败不重做整批；未采用新云识别服务。数据/界面：迁移 34–36 新装 + 旧库升级重复执行后比较 **95 张表 / 1,140 列及默认值 / 1,035 个约束 / 214 个索引 / 4 个触发器**目录一致；90 张既有表旧字段保留，13 条虚构业务记录不变；未生成订单 / 交易 / 策略授权 / 自动交易任务。浏览器覆盖 390 / 1280 / 1440 / 1920 / 2560 / 2880，房间比例约 0.92 或 1，输入框达 144px 后内部滚动，二十列表格保留 96–102px 可读单元格且只在自身容器滚动，无横向溢出；80% / 125% / 150% 用 CDP 视口与 DPR 等效缩放（无头浏览器键盘原生缩放未生效，不当原生缩放验证）。独立审查修复：导入快照竞争、旧确认覆盖、手动更新无效、模型修复按钮、缺失币种、停止后自动重启、取消后派发、不确定任务清理，均补回归用例；Windows 原生测试 1 个 POSIX 专属显式跳过，GitHub Linux 覆盖。

---

## 简单模拟闭环（2026-11-07）

来源：`superpowers/specs/2026-11-07-simple-simulation-loop-design.md`（16 行）、`superpowers/plans/2026-11-07-simple-simulation-loop.md`（26 行）。

### 设计要点

- 日报主策略动作一次性导入精确的已保存执行章节，打开 `/paper?investmentStrategyId=…` 草稿；复制**不启动交易、不调用模型**。
- 新用户在同一目标页先创建模拟账户，策略 ID 跨设置存活；模拟页拥有策略编辑 / 删除：删除草稿保留技术审计回执，删除当前策略原子停止自动执行并保留历史确认与成交。
- 期间 / 限额变化保留已解释规则 + 确定性预览；文本变化需要重新解释；状态区分 `configured / waiting / observing / paused / expired`。
- 日报缺失或 AI 执行输出无效时，保留明确系统撰写的观察计划与其错误；不得编造可执行指令、价格或风险限额。
- 实际完整 / 部分成交以股友频道可见消息出现，去重与权威账本 / 来源校验保持有效。

### 边界

验证使用虚构数据 + 一次性 PostgreSQL；覆盖精确来源导入、首次设置、草稿管理、过期修订、运行停止围栏、完整成交频道投递、重放。live 安装、付费研究、真实持仓、券商动作不在任务内；PR 前更新五条架构流与贡献者知识。

### 验证结论

Server **904 通过 0 跳过**（一次性 PostgreSQL 集群，全部 DB 测试变量）；Client **342 通过 0 跳过**；Native agent **175 通过 + 1 POSIX 进程取消用例在 Windows 跳过**；lint / typecheck / 生产 web 构建 / context helper（15）/ context validation / 差异空白检查通过（context validation 对变更入口点报预期 review-required 警告）。浏览器（虚构数据、独立 UI 库）：报告复制、首次账户设置草稿保留、显式激活、编辑保存、停止并移除当前策略、确认历史保留、草稿删除；390×844 紧凑评审对话框无水平溢出。独立评审修复了观察-only / 未来 / 过期 / 未知心跳状态的误导性执行状态，无剩余 P1/P2；架构图 1–5 已评审；必查 GitHub 检查在 PR 上运行；live 安装与全局已装 contributor skill 不变；部署 / 合后技能同步为独立动作。

---

## 研究记忆路线图（更新 2026-11-04）

来源：`research-memory-roadmap.md`（69 行），基线 main `6ed6c4d`。目标：个人研究 + 自动模拟盘助手，使每个论点、边界、证据、变化可解释。

### 阶段目标（issue #57–#63，路线 issue #64）

| 阶段 | issue | 目标 | 依赖 |
| --- | --- | --- | --- |
| M1 Atomic theses / 独立论点 | #57 | 产出带证据与明确缺失边界的 claims；摘要切片不冒充论点 | 现有 P1 |
| M2 Whole context / 完整注入 | #58 | token 预算整单元；每次尝试记录已发 ID/版本 + 省略原因 | M1 |
| M3 Time and provenance / 时间与来源 | #59 | 事实期间、发布、观察、论点复核时间分开；可比较证据关系 | M1 |
| M4 Reliable archives / 可靠归档 | #60 | 可重试归档任务 + 历史导入；批量召回包含更早活跃论点 | M1、M3 |
| M5 Monitoring and strategies / 条件与策略 | #61 | 有效观察产生幂等复核事件；被撤销 / 违约依赖围栏模拟订单 | M2、M3、M4 |
| M6 Research dossier / 股票研究档案 | #62 | 用户看到边界、归属、变化、已发记忆与归档 / 监控状态 | M1–M5 |
| M7 Retrieval evaluation / 检索评测 | #63 | 任务感知检索 + 反证；可复现操作级 fixture 与请求级回归 | M1–M6 |

### 已完成 / 未完成

- 执行清单：M1–M7 全部 `[x]`；全应用本地验证、迁移、独立评审 `[x]`。**勾选 = 实现 + 本地验收，非发布**；PR / CI / 合并在 issue #64 跟踪。
- 边界：保留账户隔离、修订、tombstone、本地 Agent 简单性、现有 paper 风险门；Agent 研究判断验证后可自动演化，但用户背书与风险限额分开；不编造缺失条件 / 证据日期 / 校准概率；检索记忆是不可信观点；不增加静默付费抽取；provider tokenization 仅在支持处精确；本地 CLI 内部上下文不可观察；首批监控源 = 已验证价格 + 已完成日报指标；无独立图 / 向量库、任意模型生成监控代码、真实券商执行、机构审批流程；确定性术语别名 / 关联证据之外需实测检索需求再上 embeddings；检索保留最多 100 条合格历史 + 500 条合格论点，然后冻结最多 200 条引用（候选上限，非扫描 / 展示上限）；日报总览、大规模经验挖掘、组合归因为后续增量。
- 本地验收：**498 server + 119 client + 49 desktop**；native **142 + 1 POSIX 跳过**；lint 与完整构建通过；新装 / 升级 / 重复启动迁移用生产 DB loader；双语 dossier 在真实浏览器桌面与 390px 验证。`npm run test:memory-eval` **93 个**必需操作 / 请求测试 0 跳过；**20 个**观测 API / native 请求清单与实际准备 / 发送内容一致；六个固定虚构案例中五个非空期望集为历史基线 **0/8 命中** vs 任务感知排序 **8/8**；极小预算案例正确省略整单元（刻意挑选的失败案例，非通用语义精度测量）。教程 / 架构图在忽略的 `docs/local-development/`（不上 GitHub）。

---

## 能力后端验证（2026-11-11）

来源：`superpowers/notes/2026-11-11-capability-backend-validation.md`（15 行），bundled-capabilities Task 2 实现；本 worker 未用个人 DB / 付费模型或云调用 / 真实订单。

- Migration 59：owner grants、部署就绪事实、稳定 managed AKTools 绑定、active + candidate 目录指针；Migration 60（sandbox worker）已注册并入新 schema。
- Capability GET 只读；显式 refresh 只做有界就绪 + MCP 元数据发现；激活绑定所显示 manifest / owner 修订 / 精确 AKTools 目录 ID + hash；重复相同激活保留授权修订。
- Managed AKTools 从通用模型面向外部目录排除；金融 facade 构造固定 CN 日历史 / HK 利润表请求，派发前 + 发布事务中重查授权。
- 文档任务在内部配置版本绑定授权修订；浏览器运行持久绑定（撤销 / 重新启用不能复活旧工作）；研究证据接纳在发布期间持有匹配授权锁。
- 敏感浏览器运行只能在创建时冻结的精确公开证据 URL 启动；owner / 私有库 URL 不授权导航；受信运行时范围可扩大敏感性；模型参数不能提供已批准 URL 列表；仅公开运行保留正常公开 URL 导航。
- 观测 RED：未变发现错误推进修订；缺能力服务；文档结果在撤销 / 重新启用后存活；重复相同激活推进全部授权修订；缺浏览器来源权威 / helper。
- 观测 GREEN（最终来源验证前）：server TS 检查；9 架构测试；连接授权 / 加密 / OAuth 测试；目录 no-op / 新增 / 候选测试；owner 激活 + 过期目录批回滚；稳定 managed 绑定 + 重复自定义端点；文档回执 / 来源删除 + 撤销结果测试；持久浏览器授权修订；金融不可变数据集 / 晚禁用测试；Docling + MinerU 协议测试；新装 / 升级 / 重放含持久禁用授权。
- 最终浏览器来源测试通过：精确冻结 URL 允许；追加私有查询 + 调用者伪造 URL 列表拒绝；当前私有范围收紧公开运行；仅公开运行保留公开导航；最终库搜索测试展示仅公开文档授权在显式私有材料门之前到达搜索。
- 边界：父 worker 跟踪全仓库 lint / build / CI；实际 Docling OCR / Chromium / AKTools 上游 / Docker 沙箱验收与 fixture 分离，元数据注册不得表示为已通过。

---

## Assistant 可维护性与开发 skill（2026-11-07 / 2026-11-09）

来源：`superpowers/plans/2026-11-07-squabble-development-skill.md`、`superpowers/specs/2026-11-07-squabble-development-skill-design.md`、`superpowers/plans/2026-11-09-assistant-maintainability.md`、`superpowers/specs/2026-11-09-assistant-maintainability-design.md`。

### 开发 skill（2026-11-07 批准）

- 目标：可复用的 Squabble 开发 skill（准确仓库知识 / 运维 runbook / 显式维护循环）。
- 规范源 `.agents/skills/squabble-contributor/`；全局安装 `$CODEX_HOME/skills/squabble-contributor`，回退 `~/.codex/skills/squabble-contributor`；安装戳 = 源修订标识，不维护两个独立副本。
- 入口路由 `references/repository-map.md`、`research-and-execution.md`、`development-and-tests.md`、`deployment-and-recovery.md`、`maintenance.md`；`docs/architecture.md` 拥有五张 Mermaid 图（系统 / 研究报告 / 策略执行 / 频道发布 / 真实资产账本）。
- helpers：`scripts/inspect-workspace.cjs`、`check-context.cjs`、`sync-skill.cjs`、`squabble-context.spec.cjs`；Node 内置 + `execFile` 参数数组，不用 shell 命令；`--repo` / `--help`；变更同步需 `--apply`，否则只显示计划；`context-manifest.json`（验证基线 / 区域路径 / 入口 / 引用）；命令 `test:context` + `check:context` + CI 步骤，保留现有三个必需检查 + web-only 范围。
- 本地部署定位器在私有 `~/.squabble` 状态（仓库 / 实例 / 配置位置、绑定地址、DB 版本提示；排除密码 / 令牌 / 持久 PID）；定位器和 skill 从不授予执行权；检查 / 验证从不自动安装依赖、拉取、迁移、联系模型、应用策略或重启服务。
- 状态：第 6 节 `[x]` quick_validate、`test:context` / `check:context` / lint、Mermaid + 本地文档链接验证、独立新 agent 场景、diff 审查；`[ ]` 开 PR + 等必需 CI + 合并精确已审 head；`[ ]` 全局安装已合并 skill + 创建私有环境定位器 + 验证安装引用 / 来源 / helper。现有应用实例保持运行。

### Assistant 可维护性（2026-11-09，渐进收敛）

- 目标：让投资助手代码更易导航 / 修改 / 解释，不改变行为；无新运行时依赖。检查基线 `46cb370`，独立分支 + 可审提交。
- 模块归属：`server/modules/research-core/` 拥有共享模型调用 / 证据收集 / 金融来源适配器 / 组合上下文，不依赖保留 pipeline 或体验 facade；`server/modules/research-routing/` 拥有可用已配置研究执行器选择，Experience 与模拟投资 import 一个导出 provider；`client/src/features/investment-strategies/` 拥有策略导入 / 编辑 / 评审 / 管理，pages 组合该特性、特性从不 import 页面实现；`multi-agent/` 保留 legacy run / pipeline APIs 与历史读取。
- 必须稳定契约（5）：路由 / API 载荷 / 双语可见文本 / 持久 schema 保持行为，既有报告 ID + 策略深链仍工作；Agent 完成 / 本地验收 / 报告发布保持不同，重构从不重派已存任务或调用真实模型；策略草稿与已确认执行权不同（已存修订 / 预览 hash / 期望当前策略 / request key）；新策略编辑不被无关迟到状态读覆盖；真实资产与模拟账本分离，最终订单验证 + 来源撤销检查不削弱。
- 自动化边界：ESLint `no-restricted-imports`（含等价别名）、`scripts/module-boundaries.spec.cjs`、`scripts/check-module-wiring.cjs` + `test:wiring`（真实 Nest provider 图 + 一次性 DB，不 init / listen / bootstrap）；`AGENTS.md` 短路由器 + `docs/code-reading.zh-CN.md` 中文阅读之旅。
- 本地验证（2026-11-09）：基线 client 聚焦 **34/34**；研究聚焦 **58 通过 + 2 DB 用例跳过**；最终 server 套件 PG 18.6 **911/911 0 跳过**；client **352/352**；虚构 memory eval **99/99**；native **180 + 1 POSIX skip**；dev 进程 **8 + 1 POSIX skip**；lint / 双类型检查 / Web 构建 / 5 架构规则用例 / 编译 provider wiring / 15 context helper 测试 / 结构 context 检查 / 空白检查通过；wiring 在应用创建前拒绝缺失显式测试 DB，正例解析编译应用无 init / listen / bootstrap；独立前端 / 后端 / 交付评审无可操作发现；文档评审 **31 个 Markdown 文件 / 238 个相对链接与锚点 / 1,009 个源与当前文档文件对应 23 个移动路径**；构建保留既有 large-chunk + Tailwind 模块格式警告；不声称 bundle 大小改进或完整浏览器到后端验收；CI 用 PG 16 + Linux（本地 18.6 差异有意，非 CI 替代）。
- 剩余：`[ ]` commit / push / PR + 盯必需 CI；`[ ]` 停一次性测试集群，用户运行实例不变。

---

## 关键验收数据

| 批次 | 日期 | 范围 | 结果 |
| --- | --- | --- | --- |
| 研究—策略闭环 | 2026-11-05 | 基线 `81bfbfb`，分支 `codex/research-strategy-loop`，Windows / Node 24.16.0 / PG 18.6 | server 641/641、client 201/201、local agents 167 + 1 skip、dev 8 + 1 POSIX skip、memory 99/99、lint + web build 通过、956 列表列一致；浏览器 10 股 / 5,000 USD 起点、390px 无溢出 |
| 研究体验恢复 | 2026-11-06 | 14 项任务、真实本地联调 + 十张虚构截图 | Codex 65s / OpenCode 82s；基线 330.640s / 34.270s / 18-20；缓存 278.657s / 38.497s / 20-20；95 表 / 1,140 列 / 1,035 约束 / 214 索引 / 4 触发器一致 |
| 简单模拟闭环 | 2026-11-07 | 一次性 PG 集群、独立 UI 库 | server 904/0 skip、client 342/0 skip、native 175 + 1 POSIX skip、context helper 15、无 P1/P2 |
| 研究记忆路线图 | 2026-11-04 | 基线 `6ed6c4d`、本地验收 | 498 server + 119 client + 49 desktop、native 142 + 1 POSIX skip、memory-eval 93/0 skip、20 请求清单一致、6 案例 0/8 vs 8/8 |
| 能力后端验证 | 2026-11-11 | bundled-capabilities Task 2 | 9 架构测试 + 连接 / 目录 / 文档 / 浏览器来源 / Docling / MinerU 协议测试通过；实际 OCR / 沙箱验收另计 |
| Assistant 可维护性 | 2026-11-09 | 基线 `46cb370`、PG 18.6 | server 911/911、client 352/352、memory 99/99、native 180 + 1 POSIX skip、dev 8 + 1 POSIX skip、31 MD / 238 链接 / 1,009 文件 / 23 移动路径 |

---

## 未完成项与限制

- **研究—策略闭环**：未合并主分支、未部署、无桌面安装包；首版仅全量市价模拟 + 公开行情；复杂撮合、卖空、保证金、完整公司行动、实时交易所数据不在范围；服务关闭时无法监控；Vite 前端包体积告警未处理。
- **研究体验恢复**：未采用新云识别服务；无头浏览器键盘原生缩放未生效（只做 CDP 等效缩放验证）；不承诺固定识别秒数；约 16% 总耗时差不能全部归因于缓存；Windows 上 POSIX 专属用例显式跳过，由 GitHub Linux 覆盖。
- **简单模拟闭环**：live 安装与全局已装 contributor skill 不变；部署 / 合后技能同步为独立动作；构建保留既有警告。
- **研究记忆路线图**：`[x]` 表示实现 + 本地验收，不是发布；PR / CI / 合并由 issue #64 跟踪；日报总览、大规模经验挖掘、组合归因为后续增量；embeddings 仅在实测检索需求后引入；无独立图 / 向量库、真实券商执行、机构审批流程。
- **能力后端验证**：实际 Docling OCR / Chromium / AKTools 上游 / Docker 沙箱验收与 fixture 分离，元数据注册不等于验收通过；全仓库 lint / build / CI 由父 worker 跟踪。
- **开发 skill**：开 PR + 必需 CI + 合并精确已审 head 未完成；全局安装、私有环境定位器与安装后验证未完成。
- **Assistant 可维护性**：commit / push / PR 与必需 CI 未完成；一次性测试集群待停；不声称 bundle 大小改进或完整浏览器到后端验收；本地 PG 18.6 与 CI PG 16 / Linux 的差异是有意为之，非 CI 替代。

---

## 源文档

以下为被本 README 提炼的原始文件（相对仓库根，均已随归档从当前开发路径移除）：

1. `docs/superpowers/specs/2026-11-05-research-strategy-loop.md`
2. `docs/superpowers/plans/2026-11-05-research-strategy-loop.md`
3. `docs/research-strategy-loop-validation.md`
4. `docs/superpowers/specs/2026-11-06-research-experience-recovery.md`
5. `docs/superpowers/plans/2026-11-06-research-experience-recovery.md`
6. `docs/research-experience-recovery-delivery.md`
7. `docs/superpowers/specs/2026-11-07-simple-simulation-loop-design.md`
8. `docs/superpowers/plans/2026-11-07-simple-simulation-loop.md`
9. `docs/research-memory-roadmap.md`
10. `docs/superpowers/notes/2026-11-11-capability-backend-validation.md`
11. `docs/superpowers/plans/2026-11-07-squabble-development-skill.md`
12. `docs/superpowers/specs/2026-11-07-squabble-development-skill-design.md`
13. `docs/superpowers/plans/2026-11-09-assistant-maintainability.md`
14. `docs/superpowers/specs/2026-11-09-assistant-maintainability-design.md`
