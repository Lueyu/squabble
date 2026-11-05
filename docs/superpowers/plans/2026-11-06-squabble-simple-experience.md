# Squabble 简化版开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. 用户已于2026-11-06确认按本计划开发。此文保留原任务清单，实际实现、自动化验收和剩余真人试用见[交付记录](../../simple-experience-delivery.md)。

**Goal:** 将 Squabble 改为“今日、投研室、AI投资”三个主入口，提供真实多Agent讨论和一次授权后持续运行的单一模拟账户，删除用户需要管理的版本、策略发布和实验流程。

**Architecture:** 复用报告不可变快照、Council原生Agent执行、研究记忆与模拟账本。新增用户体验聚合层和持续投资授权层，让简化界面有真正简化的服务端入口；自主研究生成的内部计划始终受用户授权、证据和成交事务约束。

**Tech Stack:** React 19、React Query、NestJS、Drizzle/PostgreSQL、现有本地Agent适配与node:test。只实施Web；桌面打包和标准A2A远程端点不属于本轮。

基线：已合并的 8e04fbc。对应产品说明：docs/squabble-simple-product.zh-CN.md。执行时从最新main创建codex/前缀独立工作树，核对新提交和迁移序号，不复用运行实例的数据库做开发测试。

## 1 改造原则与交付边界

本轮不是隐藏旧按钮。新的首页聚合、无表单讨论、持续授权、独立初始研究、受控新股发现、确认式聊天限制、全局暂停和旧数据兼容必须完整落地。

现有dailyPlanMode=bounded_ai只能收紧原规则。保留它服务旧数据，不能扩大其含义来绕过旧授权。新的自主投资通过独立父授权生成内部mandate，再复用现有执行链。

用户可见研报版本管理删除；底层快照、原始来源链、已成交证据不删除。新报告阅读接口返回“当前内容与更新时间”；历史链接返回“当时依据”。

一个AI账户可以有许多历史内部计划，但日常只展示当前思路。AI角色可以参与研究，不能直接持有纸面下单权限。

计划分三阶段交付：A完成简单阅读与真实讨论；B完成持续授权与自主模拟；C完成回访、兼容切换和端到端验收。三阶段全部验收后才算完成本轮目标，A阶段不能宣称已完成自主投资。

## 2 现有能力与需要补齐的部分

| 子系统 | 复用 | 新增或调整 |
| --- | --- | --- |
| 报告 | ResearchDocumentsService、来源固化、历史证据校验 | 当前内容投影、简化阅读、自动更新摘要 |
| 讨论 | Council会话、成员、消息、证据、任务身份与恢复 | 自动上下文、先独立提交后互相可见、公开争议与观点变化 |
| 本地Agent | LocalAgentsService与native/companion执行 | 持久成员显示身份、默认参与者选择、实际来源去重 |
| 研究记忆 | theses、事件、来源撤回、回访监控 | 自动回访任务与会话消息、无管理表单的结果投影 |
| 模拟账户 | preview/create、原币现金、行情、结算、费用与预留 | 默认单账户入口、起点资料补全、只读历史 |
| 策略执行 | mandate、route、portfolio risk、sizing、原子成交 | 持续父授权、自动计划编译与更新、最终授权复核 |
| 新股发现 | 有范围的网页搜索、行情、公司资料、同行资料 | 有预算的发现任务与证券验证，不能直接扩大原ticker工具权限 |
| 收益 | 相同起点持有不动、区间复盘、缺口与观测回撤 | 简化展示；不新增未核实的真实盘收益比较 |

## 3 状态与数据合同

### 3.1 新增表与最小字段

新增迁移使用实施时下一个空闲序号；以当前基线暂定31_simple_experience.sql和32_autonomous_investment.sql。所有记录带owner，外键及唯一约束需包含所属关系检查。

| 数据 | 用途与约束 |
| --- | --- |
| experience_preferences | owner唯一；默认团队成员ID、业务时区、新体验启用状态、默认AI账户、迁移状态 |
| research_current_views | owner、topicKey、dateKey、currentDocumentId、generationKey、generationSequence、updatedAt、changeSummary；同主题/日期唯一 |
| council_independent_submissions | session、cycle、member、executorIdentity、attempt、结构化结论、证据、submittedAt、releasedAt；提交后不可覆盖 |
| investment_policies | owner、account、revision、status、已确认基础markets/assetTypes/limits/budget、constraintRecords、effectiveConfig、confirmedAt；同账户最多一个有效父授权 |
| investment_cycles | policy、policyRevision、market/date、trigger、eventKey、state、lease、输入快照、候选、结果、mandateId；触发幂等唯一 |
| investment_constraint_proposals | owner、account、expectedPolicyRevision、结构化操作、影响文案、expiresAt、state、requestKey；确认结果幂等 |
| research_followup_jobs | owner、thesisId、observationKey、dueAt、state、lease、sessionId；同判断同新观测去重 |

扩展strategy_mandates/strategy_signals/候选：parentPolicyId、parentPolicyRevision、cycleId可为空，旧记录保持原含义。扩展Council公开消息：actualExecutor、respondsToClaims、stanceChange、evidenceCheckStatus，保留旧消息兼容。

研究判断的内容、来源、确认状态继续使用现有research-memory数据；research_followup_jobs只承担调度，不复制另一套判断库。单股当前视图dateKey固定current，组合日报dateKey为业务日。currentDocumentId指向现有ResearchDocumentVersion的不可变记录ID，而非可变的文档父对象；API将其作为只读材料引用返回，界面不显示版本概念。

实际生效限制保存在investment_policies.constraintRecords，proposal只保存待确认建议。每项限制含id、结构化值、来源提案、createdAt、expiresAt、status和revokedAt。保留基础授权，使用唯一的effectiveConfig计算器统一处理有效限制；相同数值键以最后确认且仍有效的一项为准，禁买/禁卖等布尔限制叠加。确认卡展示当前变化和到期后的恢复结果，有矛盾则拒绝应用。到期或撤销在账户锁内重新计算、递增revision并取消旧候选；定时任务和成交前检查共用幂等实现，不能由各路径自行忽略过期限制。

内部组合计划的每条规则额外保存market、marketSessionDate、validUntil、sourceCycleId和依据引用。沿用一个账户最多一个published mandate的数据库约束，不为每个市场创建互相覆盖的活动mandate。

### 3.2 关键类型

以下是新增shared契约的最小字段，数值和枚举要同步用服务端严格schema校验；owner只从登录上下文取得。

```ts
type InvestmentStatus =
  | 'not_started' | 'needs_information' | 'needs_confirmation'
  | 'running' | 'paused' | 'attention_required';

type InvestmentConstraint =
  | { kind: 'no_buy'; ticker: string; expiresAt: string | null }
  | { kind: 'no_sell'; ticker: string; expiresAt: string | null }
  | { kind: 'no_increase'; expiresAt: string | null }
  | { kind: 'position_cap'; ticker: string; percent: number; expiresAt: string | null }
  | { kind: 'cash_floor'; percent: number; expiresAt: string | null }
  | { kind: 'markets'; markets: Array<'US' | 'HK' | 'CN'>; expiresAt: string | null };

type ResearchContext =
  | { kind: 'portfolio'; date?: string }
  | { kind: 'stock'; ticker: string }
  | { kind: 'report'; documentId: string }
  | { kind: 'decision'; orderId: string };

type DebateOutcome = {
  confirmed: string[];
  disagreements: Array<{
    claimId: string;
    positions: Array<{ memberId: string; view: string; evidenceIds: string[] }>;
  }>;
  currentAction: 'observe' | 'research_more' | 'consider_action';
  nextEvidence: string[];
};
```

独立执行来源按“连接身份+实际运行供应商/模型”解析，不按头像或角色数量计算。同一底层来源的多个角色不满足新股买入的双来源要求；不同来源也不被宣传为统计独立或正确性保证。

### 3.3 新接口

保持现有底层接口服务旧记录，但新UI只调用以下入口及必要的既有读取接口。统一错误结果为code、message、needsInput可选；UI不展示堆栈、UUID或内部revision。

| 接口 | 输入 | 输出及语义 |
| --- | --- | --- |
| GET /api/today | date可选 | 概况、时间、最多3个优先事项、团队观点、最近AI行动、明确缺口 |
| GET /api/research/current | topicKey、date可选 | 当前内容、更新时间、变化说明、实际来源、相关讨论 |
| POST /api/research/current/refresh | topicKey、requestKey | 已有或新研究任务；不重复启动 |
| POST /api/research-conversations | message、context可选、requestKey | 自动创建会话或待澄清问题，服务端解析资料与成员 |
| GET /api/research-conversations/:id | 无 | 现有会话投影与真实成员、讨论进度、结论 |
| POST /api/research-conversations/:id/messages | message、replyTo可选、requestKey | 回复或待确认约束提案，不直接改交易权限 |
| GET /api/ai-investment | 无 | 默认账户、自然语言状态、思路、表现、持仓、行动、有效限制 |
| POST /api/ai-investment/preview | origin=holdings或cash，cash起点时金额币种，requestKey | 起点摘要、源修订、缺失项、默认额度；无授权副作用 |
| POST /api/ai-investment/start | previewId、补全项、market/limit确认、requestKey | 幂等创建或接管明确选择的账户、创建父授权、启动当前评估 |
| POST /api/ai-investment/pause | expectedRevision、requestKey | 原子总暂停；响应成功时已越过成交互斥边界 |
| POST /api/ai-investment/resume | expectedRevision、requestKey | 新修订和当前重评估任务，不重用旧候选 |
| POST /api/ai-investment/constraints/propose | text、sessionId可选、requestKey | 结构化建议、影响说明、需澄清项 |
| POST /api/ai-investment/constraints/:id/confirm | expectedPolicyRevision、requestKey | 应用限制并作废旧候选；过期或并发冲突返回409 |
| POST /api/ai-investment/constraints/:id/revoke | expectedPolicyRevision、requestKey | 撤销已确认限制、重新计算有效授权并作废旧候选；返回当前影响 |
| GET /api/ai-investment/decisions/:id | 无 | 当时的证据、实际参与者、授权与成交事实 |
| GET /api/ai-investment/history | 无 | 历史账户只读列表 |
| POST /api/ai-investment/restart | 新previewId、expectedAccountId、requestKey | 暂停并归档旧账户，再以已确认起点新建；不删除旧账本 |

提案有效期15分钟；市场/资金/股票身份歧义未解决时不能confirm。所有写接口均验证requestKey重复参数冲突。start/resume只有用户明确调用才启用；读取页面绝不自动开户、接管或恢复交易。

GET接口只读。首次打开当天页面需要生成摘要时，由客户端调用幂等refresh入口，与定时任务共用任务身份和已确认的研究预算；不能在GET聚合服务内隐式启动付费任务。

## 4 运行逻辑和安全边界

### 4.1 父授权到内部计划

```text
用户确认持续授权
  -> 领取带policyRevision的研究周期
  -> 有预算地发现候选并验证证券身份
  -> 真实成员分别研究和交叉复核
  -> 产出结构化研究结论与当前计划建议
  -> 确定性编译器验证为父授权的子集
  -> 原子替换内部mandate并取消旧候选
  -> 现有快慢路由
  -> 成交事务重新检查父授权、约束、证据和当前账本
```

AI只能改变子计划的股票与执行条件，不能改变父授权的市场、资产类型、风控、预算或启停状态。账户始终只有一个活动组合mandate；每个市场周期提交增量时，在账户锁内读取最新计划，替换本市场对应规则并合并其他市场仍有效的规则，重新检查全账户额度后原子发布。每条普通规则按自己的市场交易日到期，组合mandate整体有效窗口不得截断其他市场的有效规则。新计划取消旧候选并按新身份重新评估，不能复活旧订单。两个市场同时完成时必须合并，不能因后写入覆盖前一个市场。

换日和恢复必须重评估。保护规则可跨内部计划保留，但始终受父授权总开关和no_sell约束；某市场停止新增交易不应解除其他市场和已有持仓的有效保护。

现有父授权缺失的旧候选只允许在未迁移的旧账户路径内执行。已经迁移的新账户拒绝任何没有父授权绑定的自动订单，不能经MCP、旧Builder或旧scheduler绕过。

### 4.2 并发顺序

网络与模型调用均在数据库事务外。提交和成交按统一的owner锁→account锁→policy锁顺序；不要引入相反锁顺序。

暂停、约束确认、账户重新开始均递增policyRevision、关闭或限制自动执行、取消旧自动候选/待审订单、释放预留。迟到的模型结果只能作为历史记录，不能重新激活账户。

暂停与成交并发时：成交事务先取得锁并已完成的成交保留；暂停先取得锁后，后续自动成交全部拒绝。暂停响应不得声称撤销此前已完成的交易。

外部任务发送结果不确定时保留原任务身份并查询，不能重发付费工作。自动研究周期使用5分钟租约并可续租；丢失租约的旧worker不能提交计划。

### 4.3 暂停和no_sell

新的总暂停不仅暂停mandate，还关闭account.botEnabled并阻止全部自动路径。保护性退出不能在父授权检查前提前返回。

no_sell在每条自动卖出路径执行，包括保护性退出、独立扫描器、MCP自动成交与审批后的自动订单。用户手动发起交易仍需要标准资金、行情和可售校验；它不应被伪装成AI自动指令。

日亏限制只停止新增风险，不承诺封顶亏损。过期行情、停牌、交易日历、费用、滑点、可售数量、现金与预留等现有硬约束继续执行。

### 4.4 发现能力和研究预算

在独立发现任务中提供discover_candidates工具，输入只接受父授权市场、可验证资产类型、可选研究主题和最大结果数。复用现有已配置的网页搜索和同行资料，候选必须带sourceUrl、observedAt和来源摘要，再用证券身份和行情能力验证。

不修改普通单股research scope，使其可以任意查询其他账户或全市场。发现所得股票进入后续单独、明确授权的研究scope。行情可用不能单独证明它是非杠杆ETF；资产属性无法验证时排除自动买入。

自动发现、组合研讨、单股深研和回访共享每日自动任务预算；每个任务最多12次模型/Agent调用。无更严格用户预算时每日默认6个自动任务。手动讨论使用现有用户预算和实际用量提示，不能冒充自动任务绕过限制。

优先级为影响已有持仓的证据失效与风险研究、当日组合评估、新候选、普通回访。每个市场开盘前可检查是否需要评估，同一输入和已完成的当日研究复用，不重复全量研究。发现每批最多10个候选、3个深研名额，额度不足时排队或不启动。

## 5 代码组织

新增文件按职责拆分，避免把所有逻辑塞进现有StrategyService。下列名称用于任务分工，实施时保持相邻职责集中。

| 范围 | 主要文件 |
| --- | --- |
| 简化体验契约 | shared/simple-experience.interface.ts；shared/investment-policy.interface.ts |
| 今日与当前分析聚合 | server/modules/experience/experience.module.ts、today.service.ts、current-research.service.ts、experience.controller.ts |
| 简化讨论入口 | server/modules/council/council.entry.service.ts、council.independent.service.ts；修改现有council.controller/service/dialogue |
| 持续授权与约束 | server/modules/paper-trading/investment-policy.service.ts、investment-policy.rules.ts、investment-policy.controller.ts、investment-constraints.service.ts |
| 自主研究与编译 | server/modules/paper-trading/autonomous-research.service.ts、autonomous-plan.compiler.ts；server/modules/research-tools/research-discovery.service.ts |
| 统一授权检查 | server/modules/paper-trading/investment-policy.fence.ts；修改paper-trading.service、strategy-mandate.fence及scheduler |
| 判断回访 | server/modules/research-memory/research-followup.service.ts；复用monitor/theses |
| 数据定义 | server/database/simple-experience.schema.ts、investment-policy.schema.ts；扩展既有Council/mandate数据 |
| 今日前端 | client/src/pages/Today/TodayPage.tsx、TodaySummary.tsx、AttentionCard.tsx、CurrentAnalysisPanel.tsx |
| 讨论前端 | 修改CouncilPage/CouncilConversation/CouncilChatMessage；新增QuickQuestion、DebateSummary、ConstraintProposalCard |
| AI投资前端 | client/src/pages/Paper/AiInvestmentPage.tsx、StartInvestmentCard.tsx、InvestmentStatus.tsx、DecisionCard.tsx |
| 接入与路由 | client/src/api/simple-experience.ts、ai-investment.ts；client/src/components/Layout.tsx；client/src/app.tsx |

拆分只服务新职责，不顺带重构导入、账户鉴权或行情供应商。现有ResearchDocumentPage保留只读历史渲染能力，移除其新体验下的管理动作。StrategyWorkbench、SimulationExperimentsPanel和AgentBuilder不再由新主流程挂载。

## 6 阶段 A 简单阅读与真实讨论

### 任务 1 固定基线与契约

- [ ] 从最新main创建隔离工作树，读取贡献说明、核对31/32迁移序号并记录已有运行实例；不修改运行实例配置。
- [ ] 新增shared契约和严格请求schema，明确owner由认证上下文注入、requestKey幂等与错误码。
- [ ] 添加拒绝未知字段、跨owner上下文、股票歧义和重复请求参数冲突的用例。
- [ ] 提交契约和测试，随后各模块按这些合同开发，不自行发明不同状态名。

验证：运行新增simple-experience.rules.spec.ts及investment-policy.rules.spec.ts，非法输入拒绝、可用输入通过；前后端类型检查通过。

### 任务 2 增量数据与集成夹具

- [ ] 新增表、索引、外键和兼容字段；旧记录字段可空，禁止把所有旧账户直接转换为已授权新账户。
- [ ] 建立临时schema集成夹具，包含两个owner、一个活动旧账户、一个归档账户、历史成交和报告、可控市场时钟与模型stub。
- [ ] 先测试旧账本保存、current view并发更新、cycle领取去重、提案确认幂等与独立投稿隔离，再实现约束。
- [ ] 更新启动、fresh schema同步、Docker、CI迁移清单；验证新库和旧库重复应用两次后数据与列定义一致。

验证文件：server/modules/experience/experience.integration.spec.ts、server/modules/paper-trading/investment-policy.integration.spec.ts。使用真实一次性PostgreSQL，不因未设置连接就跳过交付验收。

### 任务 3 当前分析与今日聚合

- [ ] 复用现有日报事实和研究文档，将组合日报映射为业务日，将单股映射为current，先迁移已有可读取结果。
- [ ] 实现generationKey及递增generationSequence；同请求去重，较早任务晚返回不得覆盖较新已完成分析。
- [ ] 实现最多3项优先事项和明确的缺口状态，财务数字来自确定性数据，模型只生成解释与排序建议。
- [ ] 加入07:30/首次打开共用的生成任务身份和离线恢复规则，默认只补当前数据。
- [ ] 测试：无AI仍有事实；失败保留旧完整结果；旧交易依据不跟随current变化；同日跨市场asOf逐项显示。

验证：experience.integration.spec.ts和current-research.spec.ts；受控模型仅被有效生成任务调用一次。

### 任务 4 零表单投研入口

- [ ] 实现自动上下文解析，将股票、日报、决策映射为服务端校验后的固定资料；客户端不能提交任意别人的引用ID。
- [ ] 新讨论只接收问题和可选context；服务端选择允许参与的可用成员并生成标题。
- [ ] 保留现有会话、回复和任务恢复；对长会话建立有来源的摘要，读取历史消息仍可搜索。
- [ ] 测试普通主题无需ticker、同名股票只补问关键歧义、首次消息网络重试不重复收费或建会话、历史决策讨论不读取当前报告替代当时依据。

验证：council.entry.integration.spec.ts，以及现有Council上下文、native与workflow回归。

### 任务 5 独立提交和有依据的争论

- [ ] 新增本轮独立投稿阶段；所有提示词、get_discussion_context、日志投影和native工具快照均不能泄露本轮其他成员未公开输出。
- [ ] 投稿完成或达到明确的超时结束条件后公开，记录真实执行来源，缺席成员显示未完成；不生成代替发言。
- [ ] 争议引用具体claim/evidence；补查最多两轮，持久化观点保留/改变及原因，允许无共识结束。
- [ ] 初始独立阶段只能访问会话之前已有的合法研究和共同事实；界面明确是“本轮独立研究”，不宣传无先验影响。
- [ ] 测试并发提交、重启恢复、单Agent、同来源多角色、成员掉线、无分歧以及两轮后仍无证据；确认不按票数自动批准交易。

验证：council.independent.integration.spec.ts与现有native/workflow测试。UI检查真实身份、回应关系和展开分析。

### 任务 6 三入口界面和报告管理删除

- [ ] 将主导航收敛为今日、投研室、AI投资，持仓及导入等放二级入口；移动端保持相同名称与顺序。
- [ ] 新建今日与当前分析组件；移除版本号、采纳、分支、发布、手选引用和场景筛选。
- [ ] 投研室默认直接输入，消息展示真实成员与讨论小结；复杂工具过程放可展开详情。
- [ ] 历史报告链接只读显示原内容和时间，不重定向为最新；/analysis仍能按日查阅，/agent-builder迁到连接设置。
- [ ] 进行中英文、键盘操作、空状态及390px布局检查；不为纯样式重复编写实现镜像测试。

验证：client/src/utils/simple-experience.test.cjs与council-state相关测试；浏览器完成“股票→提问→回应→更新分析→查看旧依据”。

## 7 阶段 B 单一自动 AI 投资账户

### 任务 7 一次开启和持续授权

- [ ] 实现preview/start，在既有seed服务上组织一张摘要和needsInput列表；完整资料时一次确认启动。
- [ ] 创建长期父授权与默认账户映射，将产品第8节额度落为确定性配置；更严格既有预算优先生效。
- [ ] 继承超限持仓只限制进一步增加，不导入即清仓；现金起点需用户明确金额与币种。
- [ ] start先持久化授权和任务，再返回后台评估状态；无可用独立复核来源时说明等待，不假装已具备新股自主买入能力。
- [ ] 测试双击start仅一账户、源改变需重预览、跨owner拒绝、现金缺失只补问必要信息、读页面零副作用。

验证：investment-policy.integration.spec.ts、既有simulation-experiments与paper-race用例。

### 任务 8 新股发现和自主计划编译

- [ ] 新增发现工具与证券验证器；来源、市场、资产类型、代码身份及交易资料不可缺失，错误代码/杠杆ETF/未知资产类型排除。
- [ ] 每次发现最多10个候选、最多3个深研候选；优先合并重复证券，不通过别名重复占用预算或多次下单。
- [ ] 新股票首次买入必须有两个实际独立来源参与的研究与复核，关键分歧未解决则返回观察或待补资料。
- [ ] 编译器把结论转换为现有严格MandateRule，校验父授权子集，原子激活内部子计划；继续利用旧计划的确定性执行能力。
- [ ] 保留每账户单一活动mandate约束；市场增量在锁内合并其他市场有效规则，记录规则市场日期与独立到期时间，聚合额度重新校验。
- [ ] 测试自动选出不在原持仓的新股票并生成有效子计划，越市场/资产/额度拒绝，模型幻觉代码拒绝，证据撤回/父授权改变后结果不得激活。

验证：research-discovery.spec.ts、autonomous-plan.compiler.spec.ts、autonomous-research.integration.spec.ts。不得通过禁用旧source fence使新股用例变绿。

### 任务 9 周期调度与快慢路由

- [ ] 增加有唯一身份和租约的自主研究周期，支持每日市场检查、证据失效、重要事件、用户恢复触发。
- [ ] 实现共同预算与优先级，所有自动研究入口统一领取额度；失败/不确定状态禁止重复付费投递。
- [ ] 将已验证计划送入现有direct/ai/council路由；新股首笔和高风险升团队，普通条件满足时可直接执行。
- [ ] 当数据失效或预算不足时只保留仍有效的授权规则，未完成的候选等待；不得把模型失败转换为direct通过。
- [ ] 测试同一交易日多副本同时扫描、租约过期、跨时区日期、断网重启、日预算耗尽、慢研讨期间保护监控继续。
- [ ] 使用PostgreSQL并发夹具验证美股与港股周期同时完成后两组有效规则均保留，一方换日到期不覆盖另一方有效规则。

验证：autonomous-research.integration.spec.ts、strategy-fast-lane及route/monitor回归。

### 任务 10 总暂停和聊天限制

- [ ] 实现investment-policy.fence并接入每条自动成交路径，包含保护性提前返回、MCP及待审订单批准后成交。
- [ ] pause/resume/constraint confirm按统一锁顺序与revision处理；暂停响应前完成取消与预留释放。
- [ ] 聊天产生proposal，用户确认才更新；禁止卖出明确涵盖止损；过期、重复确认、修改后确认和矛盾约束分别处理。
- [ ] 持久化有效限制及撤销记录，统一到期恢复计算；测试临时提高现金比例到期、永久与临时限制并存、并发到期与成交、重复撤销以及被拦旧指令不补执行。
- [ ] 添加确定性并发测试：固定两个事务屏障，分别让暂停和成交先取得锁；检查两种结果均符合第4节定义。
- [ ] 添加迟到AI返回、旧授权引用、跨账户约束、同来源伪装复核和no_sell保护退出测试。

验收场景写入investment-policy-race.integration.spec.ts：

```gherkin
Scenario: 暂停先于自动成交取得账户锁
  Given 已授权候选正在等待模型返回
  When 暂停事务关闭总开关并递增授权修订
  And 旧模型返回通过
  Then 不新增自动成交
  And 原候选终止且预留释放
  And 恢复后必须生成新的候选身份

Scenario: 禁卖确认作用于保护性退出
  Given 某股价格已触发保护规则
  When 用户确认了明确包含保护性卖出的禁卖约束
  Then 所有后续自动卖出拒绝
  And 页面显示约束生效及其影响
```

### 任务 11 AI投资页面和可追问行动

- [ ] 替换原Paper主视图，首屏展示状态、表现、思路、行动；只在首次开启或资料缺失时展示准备卡。
- [ ] 显示实际交易前讨论与证据，不用事后生成文案代替；问问原因复用决策context入口。
- [ ] 暂停后显示明确已暂停，恢复中显示重新评估；服务离线用最后心跳判断，不能显示仍在实时监控。
- [ ] 使用既有同起点收益对照，缺边界或公司行动缺口保留未知；费用与原币资金不足清楚展示。
- [ ] 测试卡片操作不切换历史账户，重试不重复start/pause，空账户、继承超限、行情缺失、预算不足和单成员等待。

验证：client/src/utils/ai-investment.test.cjs，以及模拟与研究工作台旧测试的兼容部分。删除旧UI专属测试时必须由新用户行为测试替代对应保障，不能删除资金安全测试。

## 8 阶段 C 回访 兼容与交付

### 任务 12 判断回访和自动更新分析

- [ ] 复用现有thesis与事实事件，明确只有机器可验证或有来源的判断进入自动回访；模糊观点留在聊天。
- [ ] 每天最多3项且共享自动研究预算；同observed fact去重，无新证据不重复召集团队。
- [ ] 将回访作为原讨论的新消息，注明新资料时间、支持/否定/未知和成员观点变化。
- [ ] 新完整结论更新current view；保留原始消息和过去成交依据，不生成用户可管理的版本链。
- [ ] 测试事实被修订、数据缺失、重复事件、来源撤回、时区日期和亏损本身不能判定研究错误。

验证：research-followup.integration.spec.ts及现有research-memory全套与memory-eval。

### 任务 13 旧账户迁移与入口兼容

- [ ] 新体验按服务端开关SQUABBLE_SIMPLE_EXPERIENCE启用，部署前默认关闭；试用阶段只对受控虚构账户启用。
- [ ] 首次切换旧账户进入新模式时，明确提示“旧自动交易将暂停，核对新的投资范围后继续”，由用户点击确认接管；接管事务停止旧自动化，取消旧候选，保留账本。
- [ ] 已有活动账户优先接管；多个历史账户无活动账户时只在此次迁移让用户选择一次或新建起点，不自动合并资产。迁移前旧账户运行状态必须在新入口显式呈现，并可直接总暂停。
- [ ] 新模式已接管账户的旧写入口拒绝重新发布/切换/激活旧策略；旧报告和交易历史仍可读，归档账户自动成交永远拒绝。
- [ ] /paper?strategyId指向当时决策只读视图；旧versionId链接显示原材料；/agent-builder转到连接设置；不把历史链接自动解释为执行授权。
- [ ] 新用户默认使用新体验。旧用户切换具有可见状态，不能因打开页面就扩大权限或停止其未确认接管的账户。

验证：simple-experience-migration.integration.spec.ts，覆盖旧运行账户、多个归档账户、无活动账户、已删除来源、旧深链接及旧MCP身份。

### 任务 14 验收与发布

- [ ] 全链路使用虚构持仓与模型夹具：今日→讨论→独立质疑→分析更新→开启AI→发现新股→复核→模拟→回访→用户约束→暂停并发→恢复。
- [ ] 运行lint、完整server/client/local-agents/dev、数据库memory-eval、build:web；不启动个人付费研究或桌面打包。
- [ ] 浏览器验收中文/英文、宽屏/390px、键盘操作及错误恢复；至少5位非设计参与者进行产品第14节的可用性验证。
- [ ] 审查数据归属、提示注入、自动权限边界、订单幂等和旧数据兼容；发现高优先级问题先修复再交付。
- [ ] 更新中英文使用文档和验收记录，提交PR到main，等待Lint & typecheck、Agent tests、Docker image build及必要审阅全部满足后合并。
- [ ] 部署前备份数据库及密钥配置；先开新体验小范围试用，确认新授权与全局暂停正常再扩大。用户确认前不对其当前运行实例实施此步骤。

## 9 测试命令与验收证据

开发期按任务运行有意义的目标测试。最终验收在一次性数据库提供所有 *_TEST_DATABASE_URL 环境变量后运行：

```text
npm run lint
npm run test:server
npm run test:client
npm run test:local-agents
npm run test:dev
npm run test:memory-eval
npm run build:web
git diff --check
```

环境变量包含BUDGET_TEST_DATABASE_URL、COUNCIL_TEST_DATABASE_URL、AUTH_TEST_DATABASE_URL、STRATEGY_TEST_DATABASE_URL、MEMORY_TEST_DATABASE_URL和RESEARCH_TEST_DATABASE_URL，指向专用测试库。新增模块测试必须加入test:server脚本；迁移和真实数据库用例在最终验收时不能因为缺连接被跳过。

目标测试命令示例：

```text
npx tsx --tsconfig tsconfig.node.json --test server/modules/experience/*.spec.ts
npx tsx --tsconfig tsconfig.node.json --test server/modules/council/council.independent.integration.spec.ts
npx tsx --tsconfig tsconfig.node.json --test server/modules/paper-trading/investment-policy-race.integration.spec.ts
node --test --test-concurrency=1 client/src/utils/simple-experience.test.cjs client/src/utils/ai-investment.test.cjs
```

测试报告分别记录总数、通过、失败、跳过及原因。运行代码不代表测试已通过；不沿用上一轮641/201作为本轮结果。真实Provider在线接入验证需单独记录供应商、调用成本和用户授权，不用受控模型结果冒充模型研究质量。

## 10 需求与任务对应

| 产品说明 | 开发任务 |
| --- | --- |
| 第1至2节 方向与导航 | 任务1、6、11 |
| 第3至4节 今日和分析 | 任务2、3、6、12 |
| 第5至6节 投研室和真实讨论 | 任务4、5、6 |
| 第7节 判断回访 | 任务12 |
| 第8节 自动AI账户 | 任务7、8、9、10、11 |
| 第9节 聊天限制 | 任务4、10、11 |
| 第10节 收益和历史 | 任务11、13 |
| 第11至12节 异常与删减 | 任务3至13及各自失败路径 |
| 第13至14节 旅程与验收 | 任务14 |
| 第15节 建议默认 | 审阅确定后同步shared默认值、文案和测试夹具 |

## 11 发布观察与回退

观察自动研究额度、重复任务被拦次数、模型不确定投递、待处理队列、父授权变更后的迟到结果、暂停后的自动成交数，以及当前分析更新时间。暂停成功后的新增自动成交必须为零；发现非零立即关闭新自动执行并保留证据。

记录新用户首次提问与开启流程中的退出点，不收集无必要的完整私人对话作为遥测。可用性测试目标与自动化测试分别报告。

回退先暂停新授权自动交易，再关闭新体验入口。增量迁移和内部快照保留，不DROP数据，不让旧scheduler重新执行已经失效的订单。旧界面可只读查看新账本；恢复旧自动执行必须重新得到与其能力匹配的明确授权。

本计划没有安排“先删旧数据库再重建”的步骤。产品层删除管理功能，与历史账本和证据保存是两项独立工作。
