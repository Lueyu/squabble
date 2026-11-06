# Squabble 持仓分析与投研室体验改版开发计划

> For agentic workers: 批准后使用 subagent-driven-development 或 executing-plans 按任务推进，完成实现审查与需求核对。用户已批准实施，状态与验证记录见交付文档。

**Goal:** 用户确认导入后直接获得可读持仓简报，在比例稳定的投研室看到真实研究过程，并能恢复失败任务及多图导入。

**Architecture:** 复用现有研究、持仓、原生Agent和预算系统。补充统一执行就绪状态、逐成员任务尝试、结果规范化与批次导入存储；前端使用同一组明确状态。独立观点向用户可见与向其他模型发布分别控制，交易权限不因研究容错而改变。

**Tech Stack:** React、TypeScript、TanStack Query、NestJS、PostgreSQL、Drizzle、现有原生CLI适配器、Node测试及浏览器验收。

配套功能设计：`../specs/2026-11-06-research-experience-recovery.md`。日期：2026年11月6日。总计三阶段十四项任务。

## 1 执行边界与交付方式

用户已批准全部开发，并补充整体UI活泼轻松的要求。从最新main的codex前缀隔离分支实施，保留当前运行实例与私人数据。分为研究可靠性、日常交互、批量导入三组可审查变更；共享schema及会话状态改动由同一实现者负责，避免并行修改相同检查点。

每项任务先增加能重现问题的行为用例，再实现并运行定向检查。组件文案、简单样式不写机械断言，比例与溢出通过实际浏览器尺寸测量验证。只有基于真实CLI事件形状的适配链路通过，才能声称覆盖此次故障。

不把真实持仓、截图、会话全文、OpenCode数据库或凭据提交到仓库。真实失败只提取结构，测试中使用虚构股票与数字。本次应用内OpenCode修复使用已配置的gateway/deepseek-v4-flash，不改全局CLI文件，不切换到新服务。

原有运行中任务不直接转换为新任务并重放。升级先停止接收新自动任务，等待或确认终止已有执行，备份数据；旧研究与旧任务继续可查。迁移编号实施前核对，迁移34负责执行偏好与成员尝试，35负责导入批次，36负责分析待派发请求及冻结输入。已经交付的迁移不再追改。

## 2 文件责任与共享约定

| 单元 | 主要文件 | 责任 |
| --- | --- | --- |
| 执行就绪 | 新增server/modules/local-agents/execution-readiness.ts；修改local-agents.service.ts、local-agents.requests.ts、server/local-agents/metadata.ts | 统一连接、忙碌、有效模型和能力状态；不调用模型做每次健康检查。 |
| 输出兼容 | 新增server/modules/council/council-output.ts；修改council.dialogue.ts、council.native.ts | 统一字段说明、有限兼容转换及字段级错误；不放宽证据约束。 |
| 成员任务与恢复 | 新增council-member-attempts.service.ts、council-recovery.service.ts；修改council.service.ts | 原子领取、逐成员执行、重试与本地重解析。 |
| 任务事件 | shared/research-execution.interface.ts；local-agents.store.ts、research-journal.ts、shared/research-events.interface.ts | 所有话题都有任务身份和生命周期，工具权限独立控制。 |
| 今日 | today.service.ts、current-research.service.ts、portfolio-analysis.service.ts、TodayPage.tsx、TodaySummary.tsx、CurrentAnalysisPanel.tsx | 准确摘要、明确状态、主要操作、结果与讨论衔接。 |
| 投研室 | SimpleCouncilPage.tsx、CouncilChatMessage.tsx、CouncilResearchTimeline.tsx、QuickQuestion.tsx、Layout.tsx、themes.css | 固定比例、真实进度、逐成员结果、原地恢复。 |
| 导入批次 | 新增import-batches.service.ts、import-batch-files.ts；扩展screenshot-jobs.service.ts、screenshot-import.interface.ts | 持久队列、图片生命周期、逐项恢复与来源。 |
| 识别与合并 | screenshot-result.ts；新增screenshot-merge.ts；import.service.ts | 保留问题行、跨图去重、差异预览和事务更新。 |
| 数据迁移 | simple-experience.schema.ts、simple-council.schema.ts、新增import-batches.schema.ts；scripts/db/01_schema.sql及34、35迁移 | 保存连接覆盖配置、执行尝试、导入批次及确认回执；不改历史资金。 |

新增文件均放在现有所属目录，不引入新业务服务或独立前端框架。更新共享类型时同步API与UI，不直接把数据库行当作公开协议。

### 2.1 用户状态与内部状态

执行就绪分开返回connected、busy、effectiveModel与可执行性。未知型号可以执行已验证的默认路由；已知空模型或错误提供商必须阻止派发。执行来源确认与底层模型身份确认保留不同标志。

成员尝试至少包含owner、sessionId、cycleId、memberId、attempt、taskId、输入指纹、状态、最后活动、结果接纳状态和安全错误。唯一键为owner/sessionId/cycleId/memberId/attempt；活动尝试领取在事务内完成。

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

SafeFailure只允许白名单元数据；凭据、原始stderr、完整prompt和持仓正文不能出现在诊断摘要。存量任务若没有这些字段则显示“旧任务未记录详细原因”。

### 2.2 拟新增接口

| 接口 | 行为 |
| --- | --- |
| GET /api/research-execution/readiness | 返回当前账户可用执行来源与配置问题；结果可短期缓存。 |
| POST /api/research-conversations/:id/recovery | 接收memberId、action、requestKey和expectedRevision，恢复已有任务或重试成员；跨账户拒绝。 |
| POST /api/import/batches | 创建同账户截图批次与任务回执；凭据引用已有设置，不落入批次明文。 |
| GET /api/import/batches/:id | 返回逐图进度、结构化结果、待核对项及已保存状态。 |
| POST /api/import/batches/:id/retry | 只选择明确失败项；状态不确定项只查询原任务。 |
| POST /api/import/batches/:id/preview | 对已确认行计算新增/更新/冲突，不写持仓。 |
| POST /api/import/batches/:id/commit | 原子提交本次确认增量，返回幂等回执、持仓修订和可选分析请求。 |

既有单图接口保持兼容；新增批次UI不再以组件挂载生命周期拥有任务。所有写接口使用owner约束、输入校验、请求键和同键异参冲突检测。

## 3 阶段一 研究能够完成并可恢复

### 任务1 统一执行就绪状态并修复OpenCode配置传递

依赖：无。

文件：shared/local-agents.interface.ts、shared/simple-experience.interface.ts；server/local-agents/metadata.ts、native.ts；server/modules/local-agents/execution-readiness.ts、local-agents.requests.ts；simple-council.service.ts；today.service.ts；settings相关接口；simple-experience.schema.ts、01_schema.sql和34_research_execution_recovery.sql。

- [ ] 增加裸默认模型deepseek-v4-flash被误拆成provider且model为空的虚构fixture；验证有登录凭据仍可处于配置错误。
- [ ] 定义统一就绪投影，分开未连接、需登录、配置错误、忙碌、可执行；默认配置无法确认时保留未知状态，不伪造型号。
- [ ] 在experiencePreferences保存按连接ID的memberSettings覆盖，校验模型与思考参数；保持旧defaultMembers选择方式兼容。
- [ ] 简化投研室、日报和截图默认选择共用此来源；尊重明确配置，不在简化入口丢弃agentSettings。
- [ ] 对本次OpenCode连接写入应用内完整模型标识；不修改全局配置。错误映射到修复入口，派发前即可解释。
- [ ] 运行就绪与配置定向测试，检查无模型调用、无凭据输出。

命令：`npx tsx --tsconfig tsconfig.node.json --test server/modules/local-agents/execution-readiness.spec.ts`。新用例全部放入新增execution-readiness.spec.ts。预期全部通过，并验证坏配置的派发计数为0。

### 任务2 统一研究输出契约并无损接纳兼容结果

依赖：无，可与任务1并行。

文件：新增server/modules/council/council-output.ts、council-output.spec.ts；修改council.dialogue.ts、council.native.ts、council.service.ts；补council-native.integration.spec.ts。

- [ ] 用虚构内容复现response.details对象导致整份失败；覆盖5个文本字段，正文、6条claim、7个来源均合法。
- [ ] 统一prompt说明与解析约束，明确details、claim ID、source ID、引用、可空字段及长度，API和native使用相同契约。
- [ ] 仅支持有界Record<string,string>向分节文本的无损转换，保持原文与顺序；未知复杂对象、非法证据或超限仍拒绝。
- [ ] 错误保留response.details等字段路径与类型差异；不以删除details作为正式修复。
- [ ] 加入CLI事件流 → 文本提取 → LocalAgentsService → Council解析 → 独立稿的完整离线fixture，避免直接注入data绕过故障点。
- [ ] 验证非法引用、错误交易字段、超长正文依旧失败；仅展示容错不授予交易权限。

关键用例示意：

```ts
const raw = { response: { thesis: '虚构判断', evidencePoints: [], risks: [], nextChecks: [],
  details: { basis: '第一段', context: '第二段', allocation: '第三段', price: '第四段', sources: '第五段' } } };
// 规范化后的details必须包含全部五段；输入raw不得被原地修改。
// evidenceIds引用不存在ID时仍拒绝，错误路径可定位。
```

命令：`npx tsx --tsconfig tsconfig.node.json --test server/modules/council/council-output.spec.ts server/modules/council/council-dialogue.spec.ts server/modules/council/council-native.integration.spec.ts`。预期完整链路通过且拒绝边界仍有效。

### 任务3 全话题生命周期及安全诊断

依赖：任务1、2的共享类型。

文件：shared/research-execution.interface.ts、shared/research-events.interface.ts；server/modules/local-agents/research-journal.ts、local-agents.store.ts、local-agents.service.ts、local-agents.types.ts；server/local-agents/process.ts、failures.ts；新增server/local-agents/failures.spec.ts；council.service.ts、simple-council.schema.ts；迁移34。

- [ ] 将活动归属与证券工具researchScope解耦；组合和普通话题也记录queued/running/completed/failed/cancelled。
- [ ] 记录执行完成与结果接纳两个状态；明确任务ID、成员、尝试号及阶段。
- [ ] 保存白名单诊断：实际模型、CLI版本、阶段、退出码、输出字节数、是否有terminal事件、解析字段错误。禁止原始stderr入通用日志。
- [ ] 同一任务事件按序去重；断线重连以游标补齐；旧任务无事件显示诚实兜底。
- [ ] 原生退出、超时、输出超限、启动失败、协议未完成、模型错误分别分类，不统一映射成无连接。
- [ ] 验证事件不会给独立阶段的其他成员泄露内容或来源。

命令：`npx tsx --tsconfig tsconfig.node.json --test server/modules/local-agents/research-journal.spec.ts server/local-agents/failures.spec.ts server/modules/council/council-native.integration.spec.ts`。新增类别测试放入对应目录后纳入test:local-agents。预期组合任务有完整事件链，诊断隐私fixture无敏感值。

### 任务4 原讨论内重解析与逐成员重试

依赖：任务1至3。

文件：新增server/modules/council/council-recovery.service.ts、council-recovery.integration.spec.ts；修改simple-council.controller.ts、simple-council.service.ts、council.service.ts、council.types.ts、simple-council.schema.ts。

- [ ] 实现recovery接口，校验owner、expectedRevision、成员、动作、原任务终态及requestKey。
- [ ] 对provider已完成但解析失败的结果，读取保存文本并本地重验；不执行新的模型任务。
- [ ] 仅对明确失败且已终止的成员新建attempt；保留其他成员结果、原问题与冻结资料。
- [ ] unknown或cancel未确认时查询原任务，禁止重发；旧attempt迟到写入被拒绝。
- [ ] 记录成功恢复与历史失败；预算或暂停阻止新调用但不丢掉旧内容。
- [ ] 覆盖重复点击、跨账户访问、进程重启、迟到结果、全部失败及仅一位成功。

验收断言：重解析前后provider调用次数相同；只重试OpenCode时Codex的调用次数不变；重复requestKey得到同一attempt。使用一次性数据库执行`council-recovery.integration.spec.ts`，测试不可跳过。

### 任务5 首轮受控并行与逐位结果展示

依赖：任务3、4。

文件：新增council-member-attempts.service.ts、council-member-attempts.integration.spec.ts；修改council.service.ts、council.types.ts、simple-council.service.ts、simple-council.schema.ts、shared/simple-conversation.interface.ts。

- [ ] 将简化流程的单一remote/inflight检查点替换为逐成员attempt记录，事务领取与持久回执先于调用；旧流程保持兼容。
- [ ] 对独立执行资源设置最多2个并发，第三位排队；同一CLI锁不被绕过。预算预留先于任务进入运行态。
- [ ] 合格初稿可向用户投影展示；尚未完成成员的输入只包含冻结公共资料，不读取UI投影或他人初稿。
- [ ] 成员完成、明确失败、已确认取消或被用户明确跳过后解除首轮等待，开放交叉质疑，最多两轮补查；单人成功显示研究局限。
- [ ] 交叉讨论后重试仍使用原始冻结输入；结果作为补充观点，不自动重写已完成总结。增加终态失败解除等待与后续重试隔离的测试。
- [ ] 用户中途实质补充进入下一轮；取消/暂停阻止迟到结果成为当前结论。
- [ ] 以两个可控Promise证明并行、预算、隔离、按完成顺序展示；用真实数据库验证并发写不会覆盖其他成员检查点。

命令：`node --env-file=.env.simple-test ./node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/council/council-member-attempts.integration.spec.ts server/modules/council/council.independent.spec.ts`。预期无数据库用例跳过、最多2个并发、未提交成员prompt无他人初稿。

阶段一出口：可离线复现并修复此次两条故障路径；已保存Codex结果可以零模型调用恢复；新讨论有逐成员状态及可恢复错误。

## 4 阶段二 首页与投研室易用

### 任务6 固定比例聊天外框及滚动行为

依赖：无，可与阶段一并行。

文件：client/src/pages/Council/SimpleCouncilPage.tsx、QuickQuestion.tsx、CouncilChatMessage.tsx；client/src/components/Layout.tsx；client/src/themes.css。

- [ ] 为投研室明确容器尺寸，不使用内容固有宽度；桌面92%主内容可用宽，小屏100%，覆盖该页不适用的全局宽度上限。
- [ ] 全链路设置min-width:0、min-height:0；标题最多两行，长链接换行；表格及代码只在自身容器内横向滚动。
- [ ] 标题、成员和输入区位于房间内；消息区纵向滚动；输入超过上限后内部滚动。
- [ ] 历史和详情使用覆盖抽屉。阅读上文时不强制滚到底部，提供新消息提示。
- [ ] 浏览器在390、1280、1440、1920、2560、2880视口及80%、125%、150%缩放验证空态、长文、错误、多成员和长表格。

布局验收：桌面roomWidth/mainAvailableWidth为0.92，允许2 CSS px舍入误差；窄屏为1。页面scrollWidth不大于clientWidth加1px；消息增长前后房间宽度不变。不要用隐藏整个页面overflow-x来掩盖无法访问的内容。

### 任务7 股友状态、消息与恢复操作

依赖：任务3至6。

文件：SimpleCouncilPage.tsx、CouncilResearchTimeline.tsx、CouncilChatMessage.tsx、QuickQuestion.tsx；新增CouncilMemberActivity.tsx、CouncilRecoveryCard.tsx；client/src/api/research-conversations.ts；中英文文案。

- [ ] 主界面显示真实股友名、当前状态与已用时；模型技术信息放详情，移除unreported直出。
- [ ] 发送阶段区分sending、accepted、queued、running；后端接收后展示回执，不能等待研究完成才反馈。
- [ ] 消费统一事件，合并工具活动；无新事件展示最近活动，状态未知不说仍在运行。
- [ ] 展示逐位初稿和有对象的回复，保留实际分歧；已运行与已接纳成员区分。
- [ ] 一个聚合错误区提供本地重解析、单成员重试、修复配置、查询原任务；不再要求新建讨论或重复显示三条告警。
- [ ] 错误、刷新、切换讨论后恢复相同状态；按钮具有屏幕阅读器标签，活动消息避免每秒播报。

新增`client/src/utils/research-experience-render.test.cjs`覆盖有连接但失败不显示连接引导、单成员失败保留成功正文、未知型号不冒充真实型号。运行`node --test client/src/utils/research-experience-render.test.cjs`及相关旧Council测试。

### 任务8 今日主分析区域与可靠摘要

依赖：任务1、2、3。

文件：server/modules/experience/today.service.ts、current-research.service.ts、experience.scheduler.ts；server/modules/multi-agent/portfolio-analysis.service.ts；shared/simple-experience.interface.ts；TodayPage.tsx、TodaySummary.tsx、CurrentAnalysisPanel.tsx；相关API和测试。

- [ ] 从结构化report.summary、风险与关注事项生成阅读投影，不截取整个文档，不让dailyLedgerFacts位于摘要首部。
- [ ] 明确facts_only与AI研究完成的区别；旧Basic报告可读但不阻挡首次AI分析。
- [ ] 调整去重身份以包含输入修订、研究级别和实际执行来源；人工更新用新请求意图，重复点击复用相同意图。
- [ ] 主分析区域前置并常驻开始/进度/更新按钮；失败保留旧结果及时间。
- [ ] 先呈现可确认事实，数据缺口按字段解释；不造汇率、价格或历史收益。
- [ ] 讨论按钮携带实际当前报告不可变引用；持仓改变时不偷换上下文。

验收案例：仅连接native也能生成日报；已有Basic材料随后接入AI仍派发；相同输入和执行器重复请求不派发；摘要没有内部字段；旧报告进入讨论时引用仍一致。运行experience服务及simple-experience客户端定向用例。

### 任务9 导入确认与分析请求衔接

依赖：任务8；任务12完成后复测新版增量提交。

文件：ScreenshotImport.tsx、ImportPage.tsx、import.service.ts、experience.controller.ts、current-research.service.ts；新增import-analysis-handoff.integration.spec.ts；相关缓存键与中英文文案。

- [ ] 增加确认持仓并开始分析与仅保存持仓两个出口；手动和CSV持仓更新也能进入同一分析入口。
- [ ] 持仓、导入回执和research_analysis_requests分析意图在同一数据库事务中提交，使用确认回执ID作为幂等来源；提交后由派发器启动研究，页面立即进入今日查看状态。
- [ ] 分析未启动时保留持仓提交成功状态并提供重试，不让用户重复导入。
- [ ] 仅在确认的数据修订上分析，携带部分导入范围；invalidate holdings、today和current-research相关查询。
- [ ] 覆盖网络在提交后中断、连续点击、部分导入后补齐、已有分析正在运行、自动预算耗尽。

用一次性数据库运行handoff集成测试，断言一份确认回执最多一个分析任务，失败不重复写持仓；本地busy有明确排队原因。

阶段二出口：用户无需学习即可从持仓进入分析，聊天室比例稳定，开始、等待、完成、失败都有清楚反馈。

## 5 阶段三 多图导入与真实验收

### 任务10 持久批次及逐图恢复

依赖：任务3的事件及恢复原则。

文件：新增server/database/import-batches.schema.ts、import-batches.service.ts、import-batch-files.ts、import-batches.integration.spec.ts；修改import.controller.ts、import.module.ts、screenshot-jobs.service.ts、shared/screenshot-import.interface.ts；迁移35_import_batches.sql及01_schema.sql。

- [ ] 保存owner隔离的批次、图片指纹、状态、任务ID、尝试、人工修改与确认回执，不将整个批次保存在React内存。
- [ ] 原图只存受权限保护的本地目录，自上传起24小时到期；排队项到期取消并清理，运行项到期请求取消后等终止确认再清理。无法确认则标记清理待确认，不能删除执行器仍在读取的图片。重启补做清理，短时核对读取使用文件租约。
- [ ] 离开页面不取消服务端任务；返回读取批次，重启先核对已派发任务，未知状态不自动重放。
- [ ] 单图失败继续队列，全局认证/额度/能力错误暂停队列；仅重试明确失败项。
- [ ] 原图过期后仍保留结果、人工修改和已提交信息；缺失原图的重试清晰提示重新选择该图。
- [ ] 覆盖owner隔离、刷新/重启恢复、文件过期、取消、迟到结果、批次上传中断及资源回收。

以数据库和临时文件目录运行import-batches.integration.spec.ts；无真实截图，原图生命周期不依赖浏览器连接。

### 任务11 识别部分结果与逐步核对

依赖：任务10。

文件：server/modules/import/screenshot-result.ts、screenshot-result.spec.ts；shared/screenshot-import.interface.ts；ScreenshotImport.tsx、screenshot-import.ts；client/src/utils/screenshot-import.test.cjs。

- [ ] 识别返回有效行、问题行、未识别项与来源图片；单个坏字段不丢掉整张其他行。
- [ ] 保留原始字段及具体问题，不用0填缺失数量或成本；没有市场/代码时进入待核对而非错误匹配。
- [ ] UI显示逐图数量和累计行，允许处理剩余图片时核对已识别行；不用无依据的进度百分比。
- [ ] 人工编辑有修订记录；迟到识别只能追加建议，不能覆盖用户确认值。
- [ ] 增加仅重试失败项操作；成功结果和人工编辑不重置。

运行screenshot-result.spec.ts与screenshot-import.test.cjs。重点断言十行中一行坏字段仍有九行可核对，第十行可修正后纳入。

### 任务12 跨图合并、差异预览与增量事务更新

依赖：任务10、11。

文件：新增server/modules/import/screenshot-merge.ts、screenshot-merge.spec.ts、import-commit.integration.spec.ts；修改import.service.ts、import-batches.service.ts、ScreenshotImport.tsx及共享接口。

- [ ] 使用市场和证券身份合并，重复截图或重叠行仅合并来源；股票名称相同但身份不同不能合并。
- [ ] 数量/成本/币种冲突保留候选与来源；提交前必须核对冲突，不相加、不自动选更大值。
- [ ] 已有持仓改为明确的新增/更新差异；未出现旧持仓保留，本期不提供自动删除。
- [ ] 支持一个批次多次保存已确认增量：每次确认有独立幂等回执，仅提交新确认或新修改行，已保存行不重复应用。
- [ ] 检查持仓基础修订并在事务中写入行、导入日志和回执；并发修改冲突时重新预览，不覆盖用户的新操作。
- [ ] 每次选择保存并分析时，分析与本次确认后的完整持仓快照绑定，沿用任务9的幂等请求。

数据库用例包括7/10先保存后3张补齐、同批重复点击、重复页数量不翻倍、旧持仓数量更新、缺图不清仓、事务中断无半批写入、另一入口修改后检测冲突。

### 任务13 减少识别重复开销并验证实际提速

依赖：任务1、10至12。

文件：server/modules/import/screenshot-jobs.service.ts、ocr.service.ts；server/modules/local-agents/local-agents.service.ts；server/local-agents/native.ts、native-image.ts、tool-config.ts；ScreenshotImport.tsx；新增screenshot-performance.spec.ts。

- [ ] 测量上传、探测、启动、推理和校验耗时，以及首批可核对结果时间；记录图片数量/尺寸和执行器，不记录图片内容。
- [ ] 批次内复用未失效的能力检测，连接、模型设置变化或登录失败立即失效；工具隔离检查不得因缓存被绕过。
- [ ] 输入预检拦截坏格式与超限图片；缩放仅在清晰度与文本可读性允许时使用，原图保留供核对。
- [ ] 增加能力明确的两图小批量路径，输出每行必须有来源图片ID；来源不可靠则拒绝该批次结果并保留单图恢复入口。
- [ ] 同执行器不支持并发时使用小批量或串行；支持时最多2路，不用Promise.all绕过锁。
- [ ] 在相同模型、同一组十张虚构分页截图比较单图与优化路径，记录准确率、冲突和漏行，不仅比较总耗时。

验收不承诺固定秒数。优先保留识别正确性；若小批量不稳定则默认单图加检测缓存和逐步结果，性能报告明确该限制，不能把纯动画改进记作提速。

### 任务14 集成验收、迁移与交付

依赖：任务1至13。

文件：相关集成测试、docs/local-agents.md、docs/import.md、新增docs/research-experience-recovery-delivery.md；必要的数据库迁移和中英文文案。

- [ ] 自审需求与任务对应关系；另一审查者检查输出容错、证据、并行隔离、重试幂等、导入更新与权限边界。
- [ ] 在一次性数据库验证新装和旧库升级，重复执行迁移不损坏资料；保留旧讨论、原持仓和模拟账本。
- [ ] 完成下述自动化检查及实际浏览器验收；与本次故障有关的数据库用例不得跳过。
- [ ] 经本计划批准后进行有界真实联调：使用现有本地连接，两位成员各一次初稿，不自动重试；已有Codex结果先本地重解析。十张虚构截图在现有路径与优化路径各执行一次，识别最多20次调用，失败项不自动重新付费执行。真实调用次数及结果记录在交付文档。
- [ ] 联调确认模型确实收到材料、消息可见、失败可恢复；不能以fixture测试全绿替代真实适配验证。
- [ ] 提交审查PR，等待Lint & typecheck、Agent tests、Docker image build全部通过，处理审查意见后再按批准的交付范围合并和启动实例。
- [ ] 部署前备份并停止新自动研究；现有任务先确认终止。升级后校验UI、静态资源、原数据以及已保存失败讨论可恢复，不自动启动真实交易或重放旧研究。

必需命令：

```powershell
npm run lint
npm run test:server
npm run test:client
npm run test:local-agents
npm run test:dev
npm run test:memory-eval
npm run build:web
```

数据库测试环境变量须指向已经核实的临时数据库，使用当前项目的忽略文件加载，不输出连接串。Python代码未改时沿用CI的Agent tests；web-only阶段不要求Electron安装包或桌面打包测试。这里的“桌面宽度”指电脑浏览器布局。

`build:client`会清空静态产物。本机旧3189实例依赖兼容静态资源，不能直接覆盖共享dist后让旧实例失效；新构建使用隔离发布目录，或在明确切换时保存/恢复旧资源，并重启使用新索引的实例。

## 6 完成条件与待批准事项

三阶段依次交付可工作的结果，任务6及无共享文件的测试可以提前并行。新迁移及会话检查点由单一负责人整合。每组变更通过定向检查后提交，最终完成整体回归，不把任务“已编写”当成“已通过”。

交付记录必须列出14项任务状态、真实与离线验证边界、截图识别耗时和准确性、未解决限制、原数据验证及运行地址。可选优化若未达到质量标准，写明保守回退；必需体验和恢复功能未完成不得标为全部完成。

请批准配套功能设计和本计划。批准内容包括：92%比例布局、导入后简报优先、真实活动与逐位观点、原讨论恢复、同账户截图更新、上述应用内OpenCode配置修复，以及有界的真实本地连接联调。本次文档没有执行这些变更。
