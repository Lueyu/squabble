# V5 研究室：聊天、策略访谈与可见 Skill 执行

状态：按 Figma 163:1052 / 163:1169 实现并完成隔离验证。2026-11-10。

## 目标与现状

研究室成为一个稳定的聊天工作区：左侧切换「聊天记录 / 我的策略」，中间持续对话，输入 `/` 选择研究技能。`/strategy` 在同一工作区开始多轮策略访谈，先问清条件，再生成可核对的规则与预览；不会因为聊天或生成草稿而自动激活交易。

现有实现已经具备四个受信金融 Skill、持久化研究会话与删除墓碑、多 Agent 独立研究及讨论、按真实任务关联的公开工具活动、带修订和回执的策略访谈。问题是这些能力没有形成一个连续界面：Skill 仅由旧研究 workflow 自动选择，研究聊天没有显式选择契约；完成后的活动层层折叠；策略访谈与策略库仍跳出研究室。

此次复用现有可靠执行和持久化边界，不增加第二套聊天引擎。已读取用户提供的 `D:/stock/artifacts/finance-skills` 及 `README-金融Skill移植指南.md`，移植财报、公告、个股复盘、组合风险和研究标准等方法，不复制其中个人画像、外部供应商专有能力或执行脚本。UI 与 Skill 文案使用 Squabble 品牌；实际模型提供方 `doubao` 的身份字段保留。

## 可观察行为

1. 研究室桌面左栏固定保留「新对话」，聊天 / 策略两个列表切换；移动端同内容放抽屉，关闭抽屉返回原对话。切换不丢未发草稿，不由迟到请求抢走当前选择。
2. 聊天以清楚的用户消息、动物形象股友回复、公开研究摘要组成。股友旁显示正在使用的技能，工具调用显示动作、状态、耗时与来源数量；细节和引用可展开。失败和不可用保持可见，不能被当成已成功调用。
3. 输入 `/` 显示有名称、用途的一行技能菜单。选择普通金融技能形成可移除的输入标签，原问题仍由用户编辑。输入完整命令也能选择；未知命令给出明确提示，不伪装成已执行技能。
4. `/strategy` 进入同页策略对话。选择目标模拟仓、保留自然语言原文、逐项问清约束、显示已确认与待确认条件。保存 / 继续、预览 / 核对维持原服务的幂等回执与修订检查。
5. 策略库侧栏显示未完成访谈和已有规则版本，点击在当前工作区打开；已有历史深链接继续可用。目标账户与草稿状态始终可辨，明确的组合管理动作才前往对应账户。
6. 资料库导入是来源证据，研究记忆中的 thesis 是历史投资判断；两者分别标注，检索导入资料不会自动形成已采纳判断。

## 服务端 Skill 契约

受信包仍位于 `server/modules/research-skills/`，使用严格 manifest、固定版本与 SHA-256 内容哈希。前端只能提交受信 `skillId`；不得传递任意 Skill 指令、工具授权、执行代码或本机目录。新增只读目录接口返回用途、命令、版本和所需能力，不返回私密配置。

首批目录包含九个受信研究 Skill：`/financials` 财报核验、`/peers` 同业比较、`/valuation` 估值区间、`/challenge` 反方核查、`/read` 资料精读、`/announcement` 公告解读、`/daily-stock` 个股复盘、`/portfolio-review` 账户复盘、`/industry` 行业研究。新增包均有正常 / 缺失 / 反例 fixture。`/strategy` 是第十个可发现的交互工作流入口，由现有策略访谈 API 执行，不注入虚假的研究执行回执。

`CreateResearchConversationInput` 与 `ResearchConversationMessageInput` 增加 `skillId?: string | null`：省略沿用当前会话已钉住的技能，`null` 明确清空，新 id 由服务端校验并钉住完整上下文。初次 create 省略即普通聊天。活动中的任务保持原技能和输入，切换技能只允许已结算边界；普通补充消息继续按已有安全边界进入对话。请求哈希包含技能选择，未确认请求重试必须保持同一个输入和 requestKey。

已选择的 Skill pin 持久化在 checkpoint JSON，同时记入发起消息的公开标识与每个实际成员 attempt 的冻结输入。恢复 / 重试使用已保存的 pin，不能在软件升级后悄悄换版本。新建 cycle、初始化成员、重试独立成员等路径均需要保留该字段。模型上下文使用固定 Skill 内容，实际 API 和本地 Agent 两条路径同时覆盖；Skill 指令不能提升研究工具的任务范围或写权限。

`ResearchActivity` 增加 `kind: 'skill'` 与最小公开标识（id / version / title）；只在指令实际进入该成员请求时记录「已加载」，不能由客户端点击代替执行回执。事件关联原 taskId / memberId / turn / cycle / attempt，历史恢复继续关联同一条股友回复。普通 API 模型使用已有快照，只能标注已加载指令 / 可用快照，不能声称调用没有实际执行的 MCP 工具。原生 Agent 的工具调用继续来自持久化 journal。

只呈现公开可审计活动和最终研究摘要，不输出模型私密思维链、原始输入、stderr、账号凭据或完整内部提示词。

## 资料检索集成契约

数据基础 agent 提供 `DataLibraryService.search(owner, { query, limit?, sourceIds? })`，结果为 `{ items, asOf, truncated }`；每项包含 `sourceId / versionId / title / kind / sourceUrl? / fileName? / locator / excerpt / observedAt / validity: 'current'`。最多 10 项，每段最多 1200 字符。服务自身按 owner 和删除状态过滤；凭据不出服务边界。

研究侧注册只读 `search_data_library`，调用上述服务。工具 envelope 的来源显示投影为 title / sourceUrl / fetchedAt，固定 sourceId / versionId / locator 保留在 data.items，并随工具证据快照保存。调用后和后续研究使用前以 `validateReferences(owner, [{sourceId,versionId}])` 重新检查来源归属、停用和删除状态。内部多次工具调用的累计来源先去重、按 30 项分批验证，总量最多 1000；外部单次 30 项限制保留。删除或停用立即退出检索；既有历史快照仍可读，但不能以失效来源重新研究。

资料中心可用 `/research?sourceId=...&versionId=...` 固定资料版本。创建前服务端校验 owner 和可用性，只将有界片段放入上下文。报告发布保留 `libraryReferences`，报告再次用于研究时沿受信 references 图展开验证，并向新会话顶层证据传递来源。成功发布与执行策略验证在自身事务中共享锁定来源，来源删除不能穿过提交边界。`server/database/data-library-visibility.ts` 提供相同语义给记忆读侧与批量报告投影；显式畸形引用 fail closed，旧报告没有该字段则兼容原路径。

历史报告工具也按相同可用性过滤。报告 / 记忆工具只持久化来源依赖，不把历史判断正文重新复制成金融事实；工作流直接提交的记忆依赖保存在实际 attempt 中。最后发布使用锁内最新证据与原快照的并集，并携带实际提交的依赖，避免总结期间读取的新来源丢失。记忆原生派发的最后本地 handoff 同时共享锁定资料来源。已有非 simple 的组合研究保留原先不开放合成证券工具 scope 的行为。

工具遵循现有 ResearchToolScope、取消 / 超时 / 调用预算、结果字节上限和 owner fencing。资料片段均为不受信数据，不可当作新的系统指令。

组合会话现有 native researchScope 被禁用；本轮只为组合开放讨论上下文、owner 研究记忆和资料检索，不能把 `PORTFOLIO` 交给证券报价或网页扩展。并行成员的 scope 验证以实际持久化 attempt 身份为准，不依赖另一个成员的 `nextTurn`。

金融数据配置经只读 `get_financial_source_data` 进入真实研究工具链。输入仅允许受信 provider 与 operation，证券固定为服务端 scope.ticker；组合上下文不开放此工具。数据 agent 提供 `DataFinancialService.query(owner, { provider, symbol, operation })`，返回标准数据、来源、asOf 与 freshness。首版 Alpha Vantage 的 quote / daily-history 按日终能力标注，不能替代模拟盘实时成交报价。

## 实现文件与职责

- `shared/research-skills.interface.ts`：公开目录 / 选择描述；`shared/simple-conversation.interface.ts`：请求选择和视图公开标识；`shared/research-events.interface.ts`：真实 skill 活动。
- `server/modules/research-skills/`：可发现的命令元数据、按 id 钉住、扩展包与 fixture；保持旧 workflow 的 task-kind 选择兼容。
- `server/modules/council/simple-council.controller.ts`、`simple-council.service.ts`、`council.types.ts`、`council.service.ts`：目录、选择校验、冻结 / 恢复、两条执行路径真实指令加载与公开事件。
- `server/modules/research-tools/`：资料检索只读工具、数据服务适配和引用验证。数据基础 agent 独立负责 `shared/data-library.interface.ts`、DataLibraryModule / Service，不同时改研究 registry。
- `client/src/features/research-workspace/`、`pages/Analysis/ResearchWorkspacePage.tsx`：左栏、技能菜单、选择与草稿保存、同页策略入口。
- `client/src/pages/Council/ArchivedCouncilPage.tsx`、`QuickQuestion.tsx`、`CouncilChatMessage.tsx`、`CouncilResearchTimeline.tsx` 及必要样式 / 工具：ChatGPT 式聊天与可读活动。
- `client/src/features/strategy-interview/`：抽出可嵌入访谈 / 新建面板；原路由通过包装复用，不另写策略状态机。
- `client/src/api/research-conversations.ts`：目录与选择 API；受影响中英文文案与行为测试。

此子任务不修改日报、股友列表、设置或数据中心页面，由 root 与数据 agent 协作。

## 验证

用隔离测试数据库和假执行器验证：受信技能目录 / 未知 id 拒绝、版本固定与升级重试、技能变更幂等冲突、活动中切换不污染已发任务、API / 本地执行路径的 skill 回执与历史关联、并行原生成员 preflight 前 scope 授权、数据来源 owner / 删除过滤、工具失败不显示成功。新增 `council.skills.integration.spec.ts` 还覆盖 40 个唯一来源的累计验证、重复引用去重、畸形引用拒绝、真实 publish→历史报告→删除来源→新研究拒绝（历史仍可读）。

前端交互测试覆盖 `/` 菜单、未知命令、策略同页恢复、聊天 / 策略切换后的草稿保留、迟到创建不抢选择、普通补充与技能选择一同冻结、资料固定版本显式发送、移动抽屉返回。活动渲染测试覆盖默认展开 Skill 与真实失败工具。已有策略预览及显式采纳边界复用原测试。3193 虚构数据库页面实际检查了 slash、历史和同页策略；已有3192个人实例保持只读，不调用付费模型，不修改真实持仓与研究记录。

完成后 root 统一运行类型 / Lint / 构建 / 集成与架构知识检查，并通过受保护 PR 合入主干。
