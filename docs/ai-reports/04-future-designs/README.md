# 04 · 前瞻设计（V5 / V4 刷新，AI 迭代归档）

## 归档说明

本目录提炼自 `docs/` 根目录 AI 生成的 V4/V5 前瞻设计文档，原文件已删除；这些是设计提案与实施/验证记录，不代表当前实现。涉及 V5（数据中心、Figma 设计、研究数据实现、研究技能）与 V4（总览刷新、研究记录、交付验证）。保留精确事实：页面名、表/字段名、版本标识（migration 46/47/48/49/50）、验证数字；未编造未声明的实现状态。

## V5 数据中心

状态：审计与实施契约，2026-11-10。UI 先由 Figma 完成；本文件不表示外部站点已接通。Pickalpha 的准确 URL、登录方式与用户授权会话尚未提供。

**目标**：数据中心在同一页面完成资料保存、查看、同步和金融数据源管理，不是其他菜单的链接集合。研究室和记忆页消费同一批具有版本与来源的资料；导入资料只形成证据，不代表用户或股友已采纳其中的投资观点。

**页面结构**：三个平级页签 **我的资料 / 网站订阅 / 金融数据源**，页签与页面标题左对齐；详情优先右侧抽屉（关闭后保留筛选、滚动位置），独立详情页始终显示"返回数据中心"并恢复原页签。
- 我的资料：搜索、类型筛选、添加文本页面、上传文件；列表显示标题、类型、来源、更新时间和"可检索 / 待补充文字 / 提取失败"。
- 网站订阅：名称、域名、同步频率、最后成功时间、更新数量；行内同步、暂停、修改授权、删除；新增订阅输入 URL、HTML/RSS/JSON 类型、授权方式和周期，不要求用户理解向量数据库。
- 金融数据源：供应商独立卡片，显示覆盖市场/能力、凭据是否已保存、上次实际测试结果、样例数据时间；编辑、测试、停用在本页完成。

**技术选型**：首版继续使用现有 PostgreSQL（原文 + 不可变版本 + 全文检索），中文采用 `simple` 配置并补充受限中文原文匹配；只有测量发现语义召回不足后才增加嵌入与 pgvector（可与全文检索组合，不是保存前置条件）。对照 Codex/ChatGPT 仅借鉴统一资料入口、来源和权限体验，不宣称复制其私有内部架构。

**数据模型**（新建 `data-library` 模块，不依赖 research-tools / LLM 模块；4 张表）：
1. `data_library_sources`：`id / owner / kind / title / canonical_url / file_name / mime_type / enabled / auth_kind / secret_enc / sync_interval_minutes / next_sync_at / latest_version_id / state / last_success_at / last_error_code / deleted_at / created_at / updated_at`
2. `data_library_versions`：`id / owner / source_id / version / content_hash / raw_content / extracted_text / sections / content_type / byte_length / observed_at / effective_url / extraction_state / created_at`（每次成功内容变化追加版本，重复哈希不产生新版本）
3. `data_library_sync_jobs`：`id / owner / source_id / state / started_at / finished_at / lease_until / attempt / outcome / version_id / error_code / created_at`（不保存 HTTP 响应错误全文、Cookie、Token 或登录页）
4. `financial_data_connections`：`id / owner / provider / enabled / secret_enc / last_test_at / last_test_ok / last_test_code / created_at / updated_at`（一个 owner 每 provider 一条连接；供应商 ID 与能力来自服务端 allowlist）

首版有限大小文件用 Postgres 文本列保存受限 Base64 原文件（原文件最多 8 MiB，避免部署新对象存储）；较大文件/大量图片以后迁移对象存储，保持内容哈希与引用 ID 不变。

**API**：路由统一在 `/api/data-library`（auth guard + 用户上下文，不接受请求体中的 owner）：`GET/POST /sources`、`PATCH /sources/:id`、`DELETE /sources/:id`、`POST /sources/:id/sync`、`POST /files`、`GET /sources/:id/versions`、`GET /sources/:id/file`、`GET /jobs`、`POST /search`、`GET/PUT/DELETE /financial`、`POST /financial/:provider/test`、`POST /financial/:provider/query`（查询体 `{ symbol, operation }`）。共享类型由 `shared/data-library.interface.ts` 承载；与 research agent 约定 `search(owner, { query, limit?, sourceIds? }) → { items, asOf, truncated }`（最多 10 条、每条摘录最多 1200 字符，`validity: 'current'`）与 `validateReferences(owner, refs)`。owner、secret、原始授权头不进入模型结果或聊天轨迹。

**与当前实现的差异**（现有代码与复用位置）：`client/src/pages/Workspace/DataCenterPage.tsx` 当前是数据健康/导入/归档/设置的链接索引，缺少资料 CRUD 与站点同步；`server/modules/settings/settings.service.ts` + `client/src/pages/Settings/IntegrationSettingsPanel.tsx` 的 `financial` 只支持公共行情/Finnhub（个人 Finnhub 密钥加密保存在 `user_api_settings`，迁移不可丢失）；`server/modules/settings/settings-security.ts` 已有 AES-256-GCM、主密钥轮换失败状态、公共 DNS 检查和连接时地址固定；`server/modules/quote/quote.service.ts` 为 Tencent/Sina/Yahoo 公共行情，当前 `getQuote` 无 owner；财报证据在 `server/modules/research-core/sec-evidence.service.ts`、`finnhub-evidence.service.ts`；研究检索经 `server/modules/research-tools/` 只读边界（不把任意 URL 抓取权限交给模型）；`server/database/research-documents.schema.ts` 不适合混装原始订阅文章，资料应有独立 source/version 表；记忆 `server/modules/research-memory/research-memory.service.ts::inventory` 已按 owner/来源可见性管理，新增资料来源区独立展示；文件经验复用 `server/modules/import/import-batch-files.ts`、`import-batches.service.ts`。

**受控抓取与调度**：只允许 HTTPS/443、无 userinfo/片段/secret 查询参数，禁止 localhost/私网等地址与 DNS rebinding；最多 3 次重定向（跨 origin 停止为 `auth_redirect_blocked`）；默认 GET、User-Agent 标识 Squabble、总超时 15 秒、响应最大 4 MiB；授权支持无授权、Bearer Token、Cookie session、HTTP Basic（AES-256-GCM 加密，Basic 仅组装为该 origin 认证头）；401/403/登录页/空壳页转 `needs_auth` 或 `no_content`，不建立正文版本。worker 每分钟扫描 `next_sync_at`，最小同步频率 60 分钟；每账户最多 2 个同步、全服务最多 16 个；金融查询每账户每分钟最多 30 次且同时最多 2 次；成功内容按 SHA-256 去重。

**金融数据源方案**：公共行情（现有 Tencent/Sina/Yahoo，CN/HK/US，无密钥，不承诺商业实时 SLA）；SEC EDGAR（公开，无 API key，非交易报价源）；Finnhub（复用个人加密密钥，旧 settings API 兼容，HTTP 403/429 分别显示权限/限流）；Alpha Vantage（新增实际 `GLOBAL_QUOTE` 与 `TIME_SERIES_DAILY` 读取，默认按官方文档为日终，不能标成实时）。消费链为数据中心显式 symbol 查询与研究只读工具 `get_financial_source_data`；服务 `DataFinancialService.query(owner, { provider, symbol, operation })` 仅接受注册组合。适配层能力注册是后续 Twelve Data、FRED、Tushare 等扩展入口；不展示没有实现读取逻辑的"已接入"卡片。

**Pickalphas 接入调查**：确认 `https://pickalphas.com/login?mode=password` 使用带动态 `$ACTION_ID_…` 的 Next 服务端表单（email/password），而非 HTTP Basic；两次同源表单验证返回 HTTP 500 且未获得会话 Cookie，不足以区分站点故障与表单协议差异；未保存可用会话，未宣称订阅已接通。**migration 50** 不生成任何自动同步或交易工作。

## V5 Figma 设计

2026-11-10。在原 Figma 文件新增独立 V5 页，保留 V4 作为未变更功能参照；设计先于应用实现，只记录 UI 与交互契约。文件 key `0dw4pcW4fkotFzqL7RxHLG`，页 `160:998`；[V5 设计页](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=160-998)、[V5 可点击原型导览](https://www.figma.com/proto/0dw4pcW4fkotFzqL7RxHLG/Squabble-V5?node-id=171-1354)；截图归档 `D:/stock/ai-friend-v5-design/`。关键稿件节点：原型导览 `171:1354`、我的股友桌面 `160:999`、投资日报 `160:1144`、研究室对话与 slash 菜单 `163:1052`、策略库与多轮策略访谈 `163:1169`、资料库选中预览 `165:1068`、网站订阅登录过期恢复 `165:1185`、金融数据源嵌入配置 `165:1275`、手机研究对话 `168:1068`、手机资料库 `168:1110`、手机股友列表 `168:1157`、资料导入弹窗 `171:1092`、策略草案选择账户和预览 `171:1239`。

**关键界面结论**：
- 视觉：沿用低饱和绿色、暖白背景与原动物身份；颜色变量 `color/ink #172B26`、`color/muted #6B7973`、`color/line #E4EAE5`、`color/soft #F5F7F4`、`color/brand #26765C`、`color/brandSoft #EAF3EC`；蓝/紫/琥珀只用于来源类别或状态，不能仅用颜色区分成功与失败。桌面稿宽 1440、主导航 224、顶部位置栏 72、内容宽 1152；卡片圆角 16、输入与按钮圆角 8–10；研究室内部侧栏 240、主体 976；手机 390 × 844、边距 16。
- 我的股友与日报：股友卡只显示动物头像、唯一账户名、短风格标签；净值为唯一大数字，主操作"查看账户"；移除"我的策略库""一起聊出策略""在总览看多仓曲线"等挤占内容。桌面三列、较窄两列、手机一列。日报每条行动固定动物头像开头，正文为"谁 → 做了什么 → 为什么"，结果标签在右侧；无 `companionId` 时用稳定动物 fallback。
- 研究室：侧栏固定"新对话"，下方 tabs 聊天记录 / 策略库；输入 `/` 打开可搜索技能菜单（稿展示 `/strategy /challenge /financials /peers`，`/valuation` 等滚动展示）；`/strategy` 开始多轮访谈，持续展示"已确认 / 待确认"；不展示或伪造模型隐藏思维链、内部 prompt、stderr。
- 数据中心：三个平级 tabs 资料库 / 网站订阅 / 金融数据源；资料库桌面为列表 770 + 24 间隔 + 358 预览；网站订阅左侧 330 列表、右侧 798 详情；金融数据源左侧 380 供应商列表、右侧 748 配置（公共行情、SEC EDGAR、Finnhub、Alpha Vantage；Alpha Vantage 日终数据明确标记）。设计示例网站标为 **Pickalphas / https://pickalphas.com/**，样稿登录错误是演示。
- 已连线 104 个可点击入口；产品实现沿用已有返回语义，不把原型导览的返回方式照搬为产品页面返回逻辑。

## V5 研究数据实现

**Goal**：让研究成为可调用技能 + 邻近策略库的持久 agent 会话；简化股友/日报呈现；把数据链接索引替换为可用的研究资料、订阅和金融连接。**Architecture**：复用 owner-scoped research sessions、public activity events、pinned research skills、strategy interviews、encrypted settings；新增 PostgreSQL 支撑的 material/source/version/sync 域（含受限原文件字节）。原始导入资料是带来源的证据，不是自动认可的投资观点；现有账本、付费任务身份和显式策略应用保持权威。**Source baseline**：main `02e9d735a368ccc794c56f9e287cff26f6093091`；隔离分支 `codex/research-skills-data-center`；基线通过 server999/client435/native181 与 required CI。

**方案与边界**（产品决策要点）：
- 保留原动物身份；`/research` 拥有聊天与策略；slash 选择器暴露实际注册技能（选中技能身份/版本必须到达执行与保存的活动记录）；私密内部推理与凭据不暴露、不伪造为思维转录。
- `/data` 含资料、订阅、金融源三视图；图片存储不等于 OCR；订阅配置绑定 URL、认证方式、周期与启用状态；加密凭据绝不发给模型、不进 API 读取、不存入提取文档。
- PostgreSQL 存元数据、提取文本、精确来源版本与全文索引；嵌入可在检索契约后添加；UI 不宣称 Codex 私有实现、不要求向量数据库才能存文件。
- 金融配置从 Settings 迁入 Data；保留现有 Finnhub 密钥与公共来源；延迟/日终值保留来源时间戳，不叫实时。金融技能参考被改编为 **九个捆绑研究方法**（另加现有策略访谈）：`/financials` 财报核验、`/peers` 同业比较、`/valuation` 估值区间、`/challenge` 反方核查、`/read` 资料精读、`/announcement` 公告解读、`/daily-stock` 个股复盘、`/portfolio-review` 账户复盘、`/industry` 行业研究。Pickalphas 用浏览器密码表单而非 HTTP Basic；通用订阅连接器已实现，但在真实会话与抓取文章被验证前不宣称已接通认证采集。
- 工作包与所有权：1 Figma first（design agent）；2 Research（research agent）；3 Data services（data foundation agent）；4 Presentation/integration（root）；5 Independent review/verification；6 Delivery（经评审 PR 合入 main + 已授权本地部署，用匹配的可恢复备份与当前运行时身份）。

**实现与验证记录**：V5 Figma states 已实现；隔离浏览器检查覆盖 1440px 桌面与 390px 移动布局、来源创建/原文/版本预览、slash 选择与策略侧栏。独立评审验证并修复：派生报告与记忆中的来源可用性、三十多个唯一来源引用、停用来源检索、上传文本元数据编辑、停用后旧金融 provider 查询；40 来源与并发事务 fixture 通过，最终评审无遗留 P1/P2。本地验证含 lint/types/styles、Nest 模块编译接线、十六个离线 Python 测试；native-agent 与开发套件在 Windows 通过（各一个 POSIX-only skip）。完整 server/client 运行与 Linux/PostgreSQL/Docker 检查仍是发布门禁，最终结果随 PR 记录。Pickalphas 认证仍是单独验证的集成。

## V5 研究技能

状态：按 Figma 163:1052 / 163:1169 实现并完成隔离验证，2026-11-10。

**设计要点**：研究室成为稳定聊天工作区：左侧切换「聊天记录 / 我的策略」，中间持续对话，输入 `/` 选择研究技能；`/strategy` 在同一工作区开始多轮策略访谈，先问清条件再生成可核对规则与预览，不因聊天或生成草稿自动激活交易。现有实现已具备四个受信金融 Skill、持久化研究会话与删除墓碑、多 Agent 独立研究及讨论、按真实任务关联的公开工具活动、带修订和回执的策略访谈；问题是没有形成连续界面（Skill 仅由旧 workflow 自动选择、聊天无显式选择契约、活动层层折叠、策略访谈与策略库跳出研究室）。复用现有可靠执行和持久化边界，不增加第二套聊天引擎；方法移植自 `D:/stock/artifacts/finance-skills` 及 `README-金融Skill移植指南.md`，不复制个人画像/外部供应商专有能力/执行脚本；UI 用 Squabble 品牌，实际模型提供方 `doubao` 身份字段保留。

**服务端 Skill 契约**：受信包位于 `server/modules/research-skills/`，严格 manifest、固定版本与 SHA-256 内容哈希；前端只能提交受信 `skillId`，不得传递任意 Skill 指令/工具授权/执行代码/本机目录。`CreateResearchConversationInput` 与 `ResearchConversationMessageInput` 增加 `skillId?: string | null`（省略沿用已钉住技能，`null` 清空）；skill pin 持久化在 checkpoint JSON 并记入发起消息公开标识与成员 attempt 冻结输入；`ResearchActivity` 增加 `kind: 'skill'` 与最小公开标识（id / version / title），只在指令实际进入成员请求时记录"已加载"。只呈现公开可审计活动与最终摘要，不输出私密思维链、原始输入、stderr、账号凭据或完整内部 prompt。`/strategy` 是第十个可发现交互工作流入口，由现有策略访谈 API 执行。

**资料检索集成契约**：`DataLibraryService.search(owner, { query, limit?, sourceIds? }) → { items, asOf, truncated }`，每项 `sourceId / versionId / title / kind / sourceUrl? / fileName? / locator / excerpt / observedAt / validity: 'current'`，最多 10 项、每段最多 1200 字符；研究侧注册只读 `search_data_library`，用 `validateReferences` 复查归属/停用/删除；内部多次调用累计来源去重、按 30 项分批验证、总量最多 1000（外部单次 30 项限制保留）。资料中心可用 `/research?sourceId=...&versionId=...` 固定版本；报告发布保留 `libraryReferences`；`server/database/data-library-visibility.ts` 提供相同语义给记忆读侧与批量报告投影。金融数据经只读 `get_financial_source_data` 进入研究工具链，证券固定为服务端 scope.ticker，组合上下文不开放此工具；`DataFinancialService.query(owner, { provider, symbol, operation })` 首版 Alpha Vantage 按日终能力标注。

**验证**：隔离测试库与假执行器覆盖受信目录/未知 id 拒绝、版本固定与升级重试、技能变更幂等冲突、活动中切换不污染已发任务、API/本地执行路径 skill 回执与历史关联、来源 owner/删除过滤、工具失败不显示成功；`council.skills.integration.spec.ts` 覆盖 40 个唯一来源累计验证、重复引用去重、畸形引用拒绝、真实 publish → 历史报告 → 删除来源 → 新研究拒绝（历史仍可读）。3193 虚构数据库页面实际检查 slash、历史和同页策略；3192 个人实例保持只读。

## V4 总览刷新

**目标**（Requested behavior）：已保存持仓快速渲染；导入持仓后立即产生当前账户数字并自动获得近期历史参考价格；股友可从列表移除；日报综合与历史阅读分页。**架构**：保留金融账本与实际保存的估值规则；独立历史价格投影用带日期的收盘价与汇率（provenance + gaps）为今日固定持仓估值，标注为当前持仓参考而非历史持仓或投资收益；新行情缓存工作异步执行、绝不调用研究模型；账户移除归档一个账户并保留金融历史。

**改动范围**（工作包全部 [x] 完成）：
- 持仓性能：仪表盘/行情变慢前独立渲染已保存持仓，刷新或辅助失败时保留可见行。
- 历史/当前标记：新增 portfolio-history provider/cache/schema，严格 dated close/FX 规则、owner-scoped 持仓身份、有界去重抓取与重试退避；未知现金不为零。
- 增量 migration 48 及其 schema/module，持仓/交易导入完成后异步预取。
- 总览前端：标题、图例、账户卡渲染当前标记，优先可靠已保存账户观察，自动回退为明确标注的历史参考。
- 股友移除：列表动作 + 一次确认，owner/revision/request 保护，只归档并停止所选账户，保留账本/报告。
- 阅读流：`/daily` 只含日报内容无历史；`/analysis` 只含紧凑分页历史列表（链接精确保存版本）；`/research/portfolio` 保留显式当前组合研究；更新路由归属、旧链接与返回行为。
- 准备新的私有生产发布，备份个人 DB/config/state，保留 native Agent 模式与 owner，部署到现有 3192 入口并验证（不调用模型）。

**是否落地**：是。验证记录齐全：client418/418、server990/990（零跳过数据库集成）、local-agent 180（一个 Windows POSIX 跳过）、architecture5/5、context15/15、lint/双类型/CSS/生产构建/模块接线通过。虚构两持仓 US/HK 导入 135ms 返回提交回执并自动预取，后续暴露 31 个完整日无需重导入；公共 provider smoke 测试取到真实 US/HK/CN 收盘与 dated HKD/CNY FX。独立评审修复：current-null 回退旧 NAV、已保存收益上的假当前日期、参考日期时区漂移、无来源合成观察标签、失败参考请求恢复、同步历史扫描成本。相关 PR89。

## V4 研究记录

**目标**：用户提出四项具体修正（owner 范围的报告版本与研究会话删除、报告列表删除交互、研究聊天工作区与导航、资产/设置对齐），然后合入 main 并本地部署；延续隔离分支 `codex/ai-friend-v4` 与 PR89，保留先前 portfolio/history 工作。

**契约**（Behavior and ownership）：后端 owner 范围报告版本与研究会话删除；增量 migration 49 持久化 tombstones 与请求回执；报告列表每行一个删除动作 + 一次确认，带显式版本身份与稳定 request key（不确定传输后重试保持同一结果）；删除最后一页最后一条记录时返回上一页。研究工作区移除四个能力链接，复用持久化研究会话形成大聊天区（桌面历史侧栏 / 移动历史层），选择/返回/创建/删除保留草稿与显式模型派发边界，现有 channel URL 保持兼容。资产次级导航与内容水平 inset 对齐；设置保留主工作区侧栏的宽度、品牌、图标、标签与选中样式，仅增加次级菜单。报告删除只删一个不可变版本而非全部版本；被删报告不再作为新研究/策略证据，既有交易与冻结快照保留；删除已采纳版本清除采纳而非静默改选；运行中或 provider 不确定的任务须结算后才能删除。

**是否落地**：部分。已完成 [x]：有意义的数据库测试（owner、请求重放/冲突、修订、版本隔离、无遗留复活、来源失效、迟到回调）、DOM 测试（取消、重试身份、单行删除、分页、聊天草稿/历史、无自动发送）、桌面/移动布局评审、独立评审并解决阻塞发现。未完成 [ ]：完整 lint/client/server/local-agent 检查、推送最终 PR head 并合并入 main、在单独 release 构建合并修订并备份/恢复部署到 3192、同步安装的 contributor skill。验证记录：3193 一次性浏览器工作区验证大聊天渲染、原文读取、按任务草稿、移动历史选择与确认/取消删除；tabs 与内容在 1440 处共享 x=264、390 处 x=20；768–1023 时设置次级导航用现有 select 控件。首个完整 server 通过暴露 Drizzle 嵌套 left join 的 nullable-field-order 回归与严格内存 loader 缺失新 source helper；会话 schema 保持非空 id 在前，六个日报发布用例全部恢复通过。

## V4 交付验证

V4 implementation verification — 2026-11-10。在现有 React/NestJS 应用中实现已批准的 companion workspace：替换导航并增加持久化产品流，同时保留账户所有权、不可变报告、显式策略应用与真实账本写边界。参考：`ai-friend-v4.md`（usage）、`v4-portfolio-workspace.md`（portfolio 契约）、`v4-daily-and-memory-workspace.md`（daily/memory 契约）、`architecture.md`。

**验证结果**：lint 通过（ESLint、server/client types、CSS）；`test:client` 406 通过零失败/跳过；`test:server` 972 通过零失败/跳过（全部集成数据库变量指向一次性 PostgreSQL）；最终整体/native 恢复评审 20 通过零跳过；`test:local-agents` 180 通过（Windows 上一个 POSIX 进程组测试跳过）；`test:architecture` 5 通过；`test:context` 15 通过；`check:context` 通过（保留语义漂移提醒）；`build:web` 通过（保留既有 large-chunk advisory）；编译模块接线通过（一个 provider owner，定时任务未引导）；migration 升级/fresh schema 一致性通过（增量 migration 46 与 47）。聚焦检查另覆盖 20 个访谈/工作区用例与 9 个恢复用例；数据库测试用专用 PostgreSQL 16 容器与独立虚构数据库/schema，AI 集成响应为 stub，native 任务恢复用 fixtures，无个人 provider 会话或付费模型调用。

**浏览器与设计评审**：真实 Chromium 检查覆盖桌面与 390/320px 移动布局；虚构账户完成 多轮澄清 → 显式接受 → 保存规则示例 → 禁用组合草稿 → 预算/启用 → 预览 → 应用到该账户。帮助关闭回到同一会话，保存/重载恢复状态；大总览保留指标/区间/账户筛选，图表/账户/返回恢复原 URL 与 500px 滚动位置。独立设计评审修复了当前问题在折叠历史上方、窄宽度保留保存/返回控件、暂停账户文案。独立后端评审验证 owner、回执、修订、不可变证据与预算边界，解决矛盾订单方向、过期保存评审、旧记忆精确查找、pending/failed 订单可见性、整体报告分类、中断派发、独立屏障延续、重复恢复使用等问题，交接时无未解决阻塞。

**明确限制**：自然语言澄清目前用保守本地解析，不支持的逻辑保持为问题/观察而非任意自主策略编译；动物身份是呈现偏好，选择投资者理念不会静默安装策略或授权执行；整体研究需要已配置研究连接与显式请求，隔离预览无模型凭据；数据中心暴露现有 provider/import 能力，旧偏好记忆 API 无完整编辑/版本生命周期；这是实现与隔离预览，不是切换个人运行实例，评审分支经正常 PR 检查进入 main。

## 现状差异与风险

**已实现 / 接近实现**：
- V4 总览刷新：全部工作包完成并验证（migration 48），已部署到 3192。
- V4 交付验证：验证记录完整（client 406 / server 972 等，migration 46/47），评审无未解决阻塞。
- V5 Figma 设计：Figma V5 页与可点击原型完成（104 个可点击入口）。
- V5 研究技能：按 Figma 163:1052 / 163:1169 实现并完成隔离验证（九个受信 Skill + `/strategy`）。
- V5 研究数据实现：V5 Figma states 已实现，独立评审无 P1/P2；但完整 server/client 运行与 Linux/PostgreSQL/Docker 检查仍是发布门禁（结果随 PR 记录）。

**未实现 / 未验证**：
- V5 数据中心：状态为"审计与实施契约"（2026-11-10），是设计提案；明确"不表示外部站点已接通"。
- Pickalphas 订阅未接通：表单登录测试返回 HTTP 500、未获会话 Cookie，认证仍为"单独验证的集成"。
- V4 研究记录：数据库/DOM 测试与独立评审完成，但完整 CI 检查、PR 合并、构建部署到 3192、同步 contributor skill 均为待办（[ ]）。
- 后续扩展未实现：对象存储迁移、OCR/视觉模型、Playwright 交互登录、Twelve Data / FRED / Tushare 适配层能力注册、pgvector 嵌入检索（仅在语义召回不足时引入）。

**风险**：这些文档是设计提案与验证记录，不代表当前实现；外部数据源接通状态（Pickalphas 未验证、SEC/Finnhub 依赖权限、Alpha Vantage 为日终非实时）不得当作已可用；Alpha Vantage 默认日终不能接入需要实时成交价的模拟交易执行器；删除/停用资料的引用语义、凭据隔离（AES-256-GCM、不进模型上下文/日志）与 SSRF/DNS rebinding 防护是数据中心落地时的关键验收点。

## 源文档

以下相对仓库根 `docs/` 的原文件已提炼并删除：

- `docs/v5-data-center-design.md`（V5 数据中心：审计与实施契约，2026-11-10）
- `docs/v5-figma-design.md`（Squabble V5：研究、股友与资料工作区设计，2026-11-10）
- `docs/v5-research-data-implementation.md`（Research skills and data workspace implementation plan）
- `docs/v5-research-skills-design.md`（V5 研究室：聊天、策略访谈与可见 Skill 执行，2026-11-10）
- `docs/v4-overview-refresh-plan.md`（V4 overview and reading-flow refinement）
- `docs/v4-research-records-plan.md`（Research records, chat workspace and navigation refinement）
- `docs/v4-delivery.md`（V4 implementation verification — 2026-11-10）
