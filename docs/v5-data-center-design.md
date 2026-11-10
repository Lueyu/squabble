# V5 数据中心：资料、订阅与金融数据源

状态：审计与实施契约，2026-11-10。UI 先由 Figma 完成；本文件不表示外部站点已接通。Pickalpha 的准确 URL、登录方式与用户授权会话尚未提供。

## 产品边界

数据中心应在同一页面完成资料保存、查看、同步和金融数据源管理。它不是其他菜单的链接集合。研究室和记忆页消费同一批具有版本与来源的资料；导入资料只形成证据，不代表用户或股友已经采纳其中的投资观点。

建议三个平级页签：**我的资料 / 网站订阅 / 金融数据源**。页签与页面标题左对齐。详情优先右侧抽屉，关闭后仍保留筛选、滚动位置；独立详情页始终显示“返回数据中心”并恢复原页签。

- 我的资料：搜索、类型筛选、添加文本页面、上传文件；列表直观显示标题、类型、来源、更新时间和“可检索 / 待补充文字 / 提取失败”。详情显示原文、提取文本、版本和来源，不显示实现细节。
- 网站订阅：名称、域名、同步频率、最后成功时间和更新数量；行内支持同步、暂停、修改授权、删除。新增订阅输入 URL、HTML/RSS/JSON 类型、授权方式和周期，不要求用户理解向量数据库。
- 金融数据源：每个供应商独立卡片，显示覆盖市场/能力、凭据是否已保存、上次实际测试结果、样例数据时间。编辑、测试、停用在本页完成。配置保存成功不等于网络测试成功，更不等于所有接口都订阅可用。

## 对 Codex / ChatGPT 资料体验的核对

本地仓库只有 Squabble 自己的资料与记忆代码，没有足以证明 Codex 资料库内部存储的实现。OpenAI 官方 Space 文档描述可编辑页面、幻灯片、表格、站点和可复用文件，也描述连接来源保留原权限；该公开文档没有说明这些内容必然存在本地向量数据库。因此这里借鉴的是统一资料入口、来源和权限体验，不宣称复制了 Codex 私有内部架构。[官方 Space 文档](https://learn.chatgpt.com/docs/space)

Squabble 首版继续使用现有 PostgreSQL：保存原文和不可变版本，建立全文检索。Postgres 原生提供文档预处理、匹配和排序；中文不能仅依赖默认英文分词，应采用 `simple` 配置并补充受限的中文原文匹配。只有测量发现语义召回不足后，再增加嵌入与 pgvector；pgvector 可以与全文检索组合，不是资料保存的前置条件。[PostgreSQL 全文检索](https://www.postgresql.org/docs/16/textsearch-intro.html)、[pgvector 混合检索](https://github.com/pgvector/pgvector#hybrid-search)

## 现有代码与复用位置

| 范围 | 当前入口 | 结论 |
| --- | --- | --- |
| 数据中心 | `client/src/pages/Workspace/DataCenterPage.tsx` | 当前是数据健康、导入、归档、设置的链接索引，缺少资料 CRUD 与站点同步。 |
| 金融设置 | `server/modules/settings/settings.service.ts`、`client/src/pages/Settings/IntegrationSettingsPanel.tsx` | `financial` 目前只支持公共行情/Finnhub；个人 Finnhub 密钥加密保存在 `user_api_settings`，迁移不可丢失。 |
| 凭据与网络限制 | `server/modules/settings/settings-security.ts` | 已有 AES-256-GCM、主密钥轮换失败状态、公共 DNS 检查和连接时地址固定；新的网页请求需要更全面的 IP 检查及逐跳重定向控制。 |
| 公共行情 | `server/modules/quote/quote.service.ts` | Tencent/Sina/Yahoo，市场代码归一化与短时缓存；当前 `getQuote` 无 owner，不能直接在全局缓存中混入个人收费源。 |
| 财报证据 | `server/modules/research-core/sec-evidence.service.ts`、`finnhub-evidence.service.ts` | 已有 SEC 财报、Finnhub 财报与新闻，以及安全错误分类。 |
| 研究检索工具 | `server/modules/research-tools/` | 现有任务绑定、只读工具边界；新增资料检索通过此边界提供，不能把任意 URL 抓取权限交给模型。 |
| 研究文档 | `server/database/research-documents.schema.ts` | 是研究报告及采纳版本，不适合直接混装原始订阅文章。资料应有独立 source/version 表。 |
| 记忆 | `server/modules/research-memory/research-memory.service.ts::inventory` | 已按 owner、来源可见性、删除/排除、时间点管理研究记忆；新增资料来源区独立展示，避免自动生成已确认 thesis。 |
| 文件经验 | `server/modules/import/import-batch-files.ts`、`import-batches.service.ts` | 可复用 owner 隔离、体积限制与删除语义。截图识别不能被资料上传隐式触发。 |

## 数据模型

新建 `data-library` 模块，不依赖 research-tools / LLM 模块。建议表：

1. `data_library_sources`：`id / owner / kind / title / canonical_url / file_name / mime_type / enabled / auth_kind / secret_enc / sync_interval_minutes / next_sync_at / latest_version_id / state / last_success_at / last_error_code / deleted_at / created_at / updated_at`。网页连接配置使用严格 schema，不接受任意脚本、任意请求头或任意 HTTP 方法。
2. `data_library_versions`：`id / owner / source_id / version / content_hash / raw_content / extracted_text / sections / content_type / byte_length / observed_at / effective_url / extraction_state / created_at`。每次成功内容变化追加版本；重复哈希不产生新版本。正文分节保留段落、条目或幻灯片定位。
3. `data_library_sync_jobs`：`id / owner / source_id / state / started_at / finished_at / lease_until / attempt / outcome / version_id / error_code / created_at`。可观测同步历史，不保存 HTTP 响应错误全文、Cookie、Token 或登录页。
4. `financial_data_connections`：`id / owner / provider / enabled / secret_enc / last_test_at / last_test_ok / last_test_code / created_at / updated_at`。供应商 ID 与能力来自服务端 allowlist，不接受用户自定义执行代码。一个 owner 每个 provider 一条连接。

首版有限大小文件使用 Postgres 文本列保存受限 Base64 原文件，避免部署新对象存储服务；目录与搜索查询明确排除附件列。原文件接口强制 owner、Content-Disposition（图片 inline，其他 attachment）和 `nosniff`。较大文件/大量图片以后再迁移对象存储，保持内容哈希与引用 ID 不变。文本版本和原文件独立，文本再提取不改变旧版引用。

## API 与跨模块契约

路由统一在 `/api/data-library`，遵循现有 auth guard 与用户上下文，不接受请求体中的 owner：

- `GET /sources`：分页、类型、状态、查询；不发外部请求。
- `POST /sources`：添加文本页面或网站连接，验证配置并加密授权信息；创建成功保持 `pending`，不能伪造已同步。
- `PATCH /sources/:id`：标题、启停、周期、重新授权。省略 secret 保留旧值，显式清除有单独字段。
- `DELETE /sources/:id`：停止后续同步与召回，清除 secret/原文/附件，保留无内容 tombstone 供既有引用解释“来源已删除”。
- `POST /sources/:id/sync`：创建去重任务并执行同一真实采集路径；页面显示真实结果。
- `POST /files`：受限 JSON Base64 文件上传，原文件最多 8 MiB；不要信任扩展名/MIME。
- `GET /sources/:id/versions`、`GET /sources/:id/versions/:versionId`：owner 与 source/version 关系校验后的版本详情。
- `GET /sources/:id/file`：下载原附件，禁止任意 filesystem path。
- `GET /jobs`：分页任务状态，只有结构化安全错误与计数。
- `POST /search`：本地只读资料检索，不抓外网、不调用模型。
- `GET /financial`、`PUT /financial/:provider`、`DELETE /financial/:provider`、`POST /financial/:provider/test`、`POST /financial/:provider/query`：目录、凭据管理、显式测试与实际能力读取；查询体为 `{ symbol, operation }`。

共享类型由 `shared/data-library.interface.ts` 承载。与 research agent 约定：

```ts
search(owner: string, input: {
  query: string;
  limit?: number;
  sourceIds?: string[];
}): Promise<{
  items: Array<{
    sourceId: string;
    versionId: string;
    title: string;
    kind: DataLibrarySourceKind;
    sourceUrl?: string;
    fileName?: string;
    locator: string;
    excerpt: string;
    observedAt: string;
    validity: 'current';
  }>;
  asOf: string;
  truncated: boolean;
}>;

validateReferences(owner: string, refs: Array<{
  sourceId: string;
  versionId: string;
}>): Promise<boolean>;
```

检索最多返回 10 条，每条摘录最多 1200 字符，空查询不倾倒整个资料库。`ResearchSource` 投影为 title/url/fetchedAt；固定版本、原文定位保留在 `data.items`。owner、secret、原始授权头不进入模型结果或聊天轨迹。研究代理负责注册 `search_data_library` 并在工具调用时检查任务权限；删除源后不得从工具缓存继续返回摘录。

## 提取能力：如实表达状态

| 输入 | 首版真实行为 | 用户状态 |
| --- | --- | --- |
| 手写文本/Markdown | 保存原文，段落分节，立即全文检索 | 可检索 |
| HTML 页面 | 安全 GET、静态正文提取、保留标题和段落；不运行网页脚本、不抓取网页中的其他资源 | 可检索 / 无正文 / 需要登录 |
| RSS/Atom | 解析条目 ID、URL、标题、正文/摘要、发布时间，保留条目定位；本轮不自动递归抓取所有站外链接 | 可检索 |
| JSON API | 固定 GET、JSON 字符串/数值树提取，深度/条目/文本上限；不允许动态执行 mapping | 可检索 / 不支持的结构 |
| TXT/MD/HTML | 类型检查、UTF-8 文本提取 | 可检索 |
| PPTX | 只解析受限 ZIP 中的幻灯片 XML 文本，按真实 slide 顺序保存定位；不执行宏、不运行外部关系 | 可检索 / 无可提取文字 |
| PNG/JPEG/WebP | 保存原图与人工备注；不自动调用视觉模型或 OCR 付费接口 | 待补充文字（可用备注检索） |
| 受保护/扫描 PDF、旧 PPT | 本轮不伪装完整理解；明确需要可提取文本版本或手工备注 | 暂不支持自动提取 |

建议 HTML 使用成熟解析器；Mozilla Readability 文档明确提醒不要开启脚本/远程资源，且它本身不是 sanitizer。应用只展示 React 转义后的纯文本，原 HTML 下载而不内联执行。[Mozilla Readability](https://github.com/mozilla/readability)

PPTX 解压必须限制总解压字节、条目数、单文件大小、压缩比和路径。JSZip 会处理相对路径穿越，但应用仍需自己的资源上限，不能把它视为 ZIP 炸弹防护。[JSZip loadAsync](https://stuk.github.io/jszip/documentation/api_jszip/load_async.html)

## 受控抓取与授权

- 保存 URL 与每次连接均验证：只允许 HTTPS、443、无 userinfo、无片段、无 secret 查询参数；禁止 localhost/私网/链路本地/组播/保留地址及 IPv4 映射绕过。DNS 所有候选地址必须公开，socket 使用同一次验证后的解析结果，避免 DNS rebinding。
- 手动处理最多 3 次重定向；每跳重验 URL、DNS 和地址。带授权的请求只允许原始 origin，跨 origin 重定向停止为 `auth_redirect_blocked`，不能把 Cookie/Authorization 转发给别站。
- 默认 GET，User-Agent 明确标识 Squabble。总超时 15 秒，响应最大 4 MiB；流式计数以实际解压后大小为准，不能仅信任 Content-Length。重定向体不解析。
- 首版授权支持无授权、Bearer Token、Cookie session、HTTP Basic；输入是用户自己的有效访问会话，AES-256-GCM 加密。Basic 用户名密码仅组装为该 origin 的认证头。禁止把账号密码保存成网页正文，也不承诺通用的表单密码/MFA/CAPTCHA 自动登录。
- 401/403、登录表单、明显登录跳转或空壳页面转为 `needs_auth` 或 `no_content`，不建立正文版本、不覆盖最后成功内容。人工重新授权后再试。
- 定时抓取只作用于用户保存并启用的 URL，不能接受模型生成任意 URL。页面提示“同步到当前账户资料库”；第三方内容视作不可信资料，不能覆盖系统工具/权限规则。
- Playwright 可作为后续特定站点的交互登录适配器，但保存的浏览器状态可包含能够冒充账户的会话信息，必须按凭据处理；不能把通用浏览器自动化当作已经实现的连接。[Playwright authentication](https://playwright.dev/docs/auth)

## 调度、幂等和删除

服务端生命周期 worker 每分钟扫描 `next_sync_at`，以数据库行锁/租约领取任务；手动同步与自动同步共用同一路径。最小频率 60 分钟，关闭服务时停止 timer；普通失败在下一个已配置周期重试，授权失效暂停自动重试直到重新授权。取消/删除/停用后，worker 在持久化版本前再次检查 owner/source 状态与 revision；晚到的抓取结果不能复活已删除资料。每账户最多 2 个同步、全服务最多 16 个；金融查询每账户每分钟最多 30 次且同时最多 2 次。

成功内容按 SHA-256 去重；无变化显示“检查完成，无更新”，更新只增加一个新版本。重试/并发任务不能产生重复 version。内置 provider 的公开缓存可共享，个人授权源的内容/缓存必须按 owner+source 隔离。

## 金融数据源方案

| 数据源 | 当前或新增能力 | 设置与真实状态 |
| --- | --- | --- |
| 公共行情 | 现有 Tencent/Sina/Yahoo，CN/HK/US 行情和现有历史路径 | 无密钥，显式测试显示具体响应来源、行情时间；不能承诺商业实时 SLA。 |
| SEC EDGAR | 现有美股/SEC 申报公司公开财报 | 无个人 API key；保留服务器 User-Agent 与限流；不是交易报价源。 |
| Finnhub | 现有美股财报/新闻/指标 | 复用个人加密密钥；旧 settings API 兼容；HTTP 403/429 分别显示权限/限流，不能判为 key 一定无效。 |
| Alpha Vantage | 新增实际 GLOBAL_QUOTE 和 TIME_SERIES_DAILY 读取 | 个人 key 加密；按返回体识别 Information/Note/Error Message；默认报价按官方文档是日终，不能标成实时。 |

SEC 的公开 JSON API 不要求 API key，覆盖申报历史和 XBRL 财务信息；Finnhub 官方客户端列有行情、新闻、财报端点，但端点存在不等于用户套餐已获得权限。[SEC API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)、[Finnhub 官方客户端](https://github.com/Finnhub-Stock-API/finnhub-js)

Alpha Vantage 官方文档区分默认日终、实时/延迟授权；首版用明确的日终样例和日线接口，不将它默认接入需要实时成交价格的模拟交易执行器。[Alpha Vantage 文档](https://www.alphavantage.co/documentation/)

实际消费链为数据中心显式 symbol 查询与研究只读工具 `get_financial_source_data`。服务 `DataFinancialService.query(owner, { provider, symbol, operation })` 仅接受注册的 provider/operation 组合；研究工具不允许模型传任意 symbol，而绑定当前任务的 ticker。结果状态兼容 `ResearchToolResult`，携带 `provider / symbol / operation / observedAt / asOf / freshness / data / sources / status / errorCode`，其中 sources 使用 `{ title, url?, fetchedAt }`，Alpha 的 freshness 为 `end-of-day`。

停用 Finnhub / SEC 会同时阻止旧研究财报、新闻、估值路径继续获取该供应商数据；公共行情开关仅作用于数据中心/新增研究查询，不停用现有订单执行行情。资料停用会停止新召回、固定资料上下文、报告再研究、记忆及关联策略依赖；历史原文仍可在当前账户中查看，恢复启用后重新允许引用。资料删除进一步清除原文与附件，既有引用按来源不可用处理。

实现验证记录：模块单元与隔离数据库测试覆盖资料生命周期、凭据轮换、来源删除竞态、同步幂等与过期、受控抓取、PPTX 限额、Alpha 实际消费和旧 Finnhub/SEC 停用路径。升级测试对比完整 fresh/upgrade catalog，并确认旧持仓、现金、模拟账本和加密 Finnhub 配置保持不变；migration 50 不生成任何自动同步或交易工作。

Pickalphas 接入调查：确认 `https://pickalphas.com/login?mode=password` 使用带动态 `$ACTION_ID_…` 的 Next 服务端表单，字段为 email/password，而非 HTTP Basic。两次只在用户授权目标上执行的同源表单验证返回 HTTP 500 且未获得会话 Cookie；这不足以区分站点服务端故障与表单协议差异。未保存可用会话，未宣称订阅已接通；真实凭据不进入代码、测试、日志或本文件。

适配层能力注册是后续扩展 Twelve Data、FRED、Tushare 等的入口。本轮不展示没有实现读取逻辑的“已接入”卡片。模型调用不接触 provider secret，只通过服务端明确能力和标准化结果取得数据。

## 验证计划与修改所有权

数据 agent 负责模块、数据库 migration/schema、共享契约、资料 API、安全 fetch、提取/调度/金融接入及测试。Research agent 负责只读 tool registry 与公开轨迹，Root 负责 DataCenter UI、Settings 迁移入口、股友/日报与最终合并。

必测：owner 横向访问、凭据不回传/不入日志、主密钥变化、SSRF 私网/DNS重绑定/重定向凭据泄漏/体积上限、401和登录页不入库、重复抓取版本幂等、删除与同步并发、定时重启恢复、PPTX压缩限制、中文检索与固定版本引用、删除后检索/记忆排除、provider 200错误体和权限/限流区分、旧Finnhub配置兼容。使用隔离数据库和伪造HTTP fixture，不接真实账户、不读写3192数据、不调用真实模型。
