# Research, skills and source materials

The research workspace keeps chat history and the strategy library in its left
sidebar. Type `/` in the composer to choose a skill. Selection is explicit; opening
a page, selecting a skill or following a material link does not start a model call.

| Command | Purpose |
|---|---|
| `/strategy` | Multi-turn strategy clarification, saved answers and review |
| `/financials` | Verify financial results and reporting bases |
| `/peers` | Compare businesses and comparable metrics |
| `/valuation` | Separate sourced facts from valuation assumptions |
| `/challenge` | Find counterevidence and invalidation conditions |
| `/read` | Read saved materials with versioned references |
| `/announcement` | Check original disclosures and event impact |
| `/daily-stock` | Review price, events and business developments |
| `/portfolio-review` | Review portfolio concentration and common risks |
| `/industry` | Examine value chains, competition and transmission |

Each research skill is a trusted bundled manifest with a version and content hash.
The request and execution attempt pin the selected version. A running attempt
cannot quietly switch its skill. The chat shows public research summaries, actual
tool receipts and skill-loading records. API snapshot mode does not invent native
tool calls; absence of a tool record is not represented as a successful call.
Private model reasoning is not exposed or reconstructed.

Strategy interviews preserve the user's original wording, clarifying answers and
accepted revisions. A strategy saved in the sidebar is a draft. Applying it still
requires an explicit account, a fresh preview and the existing confirmation fences.

## Data center

`/data` has three views: **Library**, **Subscriptions** and **Financial sources**.
The former `/settings/data` address redirects to Financial sources.

- **Library:** write a page, add a website or upload text, HTML, JSON, RSS/Atom,
  PPTX and PNG/JPEG/WebP files. Files are limited to 8 MiB; web responses to 4 MiB.
  Original files and immutable extracted versions are retained. Select a version
  before choosing **Research this version**. Editing a page makes a new version;
  an uploaded text file remains an original attachment.
- **Subscriptions:** save an HTTPS source, supported authorization and an update
  interval. Sync manually or while the running server checks due subscriptions.
  Supported authorization is host-bound Cookie, Bearer or HTTP Basic. A normal
  email/password form is not HTTP Basic. Browser-only sites may need a dedicated
  connector or a renewed session cookie. Failed authorization, unavailable text
  and unchanged responses remain visible in the sync history.
  Browser mode adds a separate local sign-in connection and rendered-page capture;
  see [browser collection](browser-source-collection.md). It preserves real
  source/version identity and never treats HTTP Basic as website form login.
- **Financial sources:** public quote adapters, SEC filings, Finnhub news and
  fundamentals, and Alpha Vantage end-of-day quotes/history expose their actual
  supported operations. Save credentials and test or query in place. Provider
  timestamps, coverage and errors accompany results. Alpha Vantage is not used as
  a real-time execution-price source.

Images are stored without OCR. Their user-written descriptions can be searched;
the app does not claim to have read pixels. PPTX text preserves slide locations.
HTML is rendered as text, never as executable source markup. Site acquisition
checks public DNS/IP addresses on every redirect, pins the resolved address for
the request, bounds time/bytes and never forwards credentials to another origin.
Write-only credentials are encrypted separately and never become research evidence.

The library uses PostgreSQL for originals, versions and a search index. It does
not require a separate vector database. This implementation makes no claim about
Codex's private storage internals. Library upload is distinct from holdings or
transaction import and never commits financial ledger rows.

## Visible memory and provenance

`/memory?tab=sources` exposes the same source inventory and versions. Sources are
evidence, not accepted investment conclusions. Disabling a source stops scheduled
sync and future retrieval; deleting a source retains a lifecycle tombstone and
prevents future use. Existing reports remain historical artifacts. Research pins
source/version identity and revalidates availability before further work; derived
report and memory paths must preserve the same source dependencies.

## 中文使用说明

研究室左侧切换“聊天”和“策略”。输入 `/` 选择财报解读、资料精读、行业研究等技能；
`/strategy` 在当前页面逐轮问清想法，策略草稿保存在侧栏。选择技能不会自动执行研究，
保存策略也不会自动下单。聊天活动展示成员的公开摘要、真实工具调用与技能加载记录。

数据中心直接管理页面、文件、网站订阅和金融数据源。点选资料可查看原文与历史版本，
再把选定版本带入研究室。采集结果同时出现在记忆的“资料来源”，可以停用或删除。
图片保存原件和说明，不冒充已完成 OCR；网站邮箱密码登录需要适配实际登录流程，
不能把它当作 HTTP Basic。定时同步要求应用保持运行。金融数据覆盖范围与延迟以返回
结果和供应商权限为准；日终报价不会被标成实时行情。
