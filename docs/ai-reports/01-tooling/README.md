# 01 · 工具与能力体系（AI 迭代归档）

## 归档说明

本目录提炼自 `docs/superpowers`（specs/plans）与 `docs/` 根目录的 Agent 工具体系、本地能力套件、source-host 工具恢复与浏览器来源采集等 AI 开发流程文档，对应原文件已删除。保留目的：记录工具/外部能力/P0–P4 实施与验收结论，供后续维护者理解"代码存在 ≠ 真实连通"的边界、预算与权限契约，以及从云端 E2B 到必备本地沙箱的架构转向。

编号说明：`2026-11-11-agent-tooling-design.md` 的交付顺序为 **P0（契约）→ P1（持久化运行/预算）→ P2（MCP 连接）→ P3（研究入口与 UI）→ 金融/文档/搜索/计算/应用并行 → Deep Agents + 完整评测**；`agent-tooling-implementation.md` 将同一工作拆为 **P0–P10 / W01–W16** 工作包（见下）。两套编号并存，均按原文件原文保留。

## 设计目标与边界

### 目标与三条底线

API Agent（Council 研究成员）要在**可追溯、可恢复、有预算权限边界**的运行层上使用既有及成熟的外部工具。混合部署已确认：资料/PDF/浏览器会话留本地；搜索/计算沙箱/应用连接走云服务。

明确不在范围：真实券商交易、无限制宿主机 shell、公共多租户 SaaS、把全部工具塞进提示词、替换账本/策略。

### 能力清单 R01–R12

| 编号 | 能力 | 方案 |
|---|---|---|
| R01 | 运行层 | AI SDK 单步持久化运行器 |
| R02 | 工具连接 | MCP 官方 TypeScript Client，远程 HTTP 优先 |
| R03 | 金融 | 复用 public/SEC/Finnhub/Alpha Vantage；AKTools/AKShare、Tushare |
| R04 | 文档 | 本地 Docling HTTP；MinerU 比较适配器 |
| R05 | 计算 | E2B Code Interpreter + pandas/NumPy/QuantStats 固定模板 |
| R06 | 搜索 | DeepSeek + Tavily 可选、Exa 可选 |
| R07 | 正文抓取 | Firecrawl scrape/crawl/map |
| R08 | 浏览器 | 本地 Playwright 来源采集；Playwright MCP/Browserbase 可选 |
| R09 | 外部应用 | Composio 用户级连接 |
| R10 | 记忆 | 来源复用 |
| R11 | 观测 | telemetry/预算账，Langfuse 可选 |
| R12 | Deep Agents | 可选后端 |

### 架构决策

- `research-runtime` 挂在 Council 之下，消费 research-core / research-tools / 中立契约；`tool-connections` 管连接/认证/发现/catalog；`research-tools` 管权限与结果边界（内部经 ResearchToolsService）；`data-library` 拥有原始资料/版本/快照；`research-compute` 只读授权快照；`tool-actions` 管写入预览/确认/回执。
- **AI SDK 只执行单步**：每次只执行一个模型 step = 一个 HTTP 请求 + 一个 dispatchKey；关闭 SDK 的 tool.execute / toolApproval / 自动重试 / 自动多步（retry=0）。
- **Deep Agents 是独立 driver**（P9/W15），子 Agent 只继承父 run 的权限子集，共用派发预算，checkpoint 加密恢复。
- 工具描述符 `AgentToolDescriptor`：`id / connectionId / catalogVersionId / schemaHash / name / description / inputSchema / effect('read'|'compute'|'external_write') / dataClasses / timeoutMs / maxOutputBytes / supportsCancellation / supportsStatusLookup / remoteIdempotency`。外部连接工具 = 连接 ID + 原工具名；运行启动时冻结 catalog / schema hash / 连接修订 / 权限 / 价格版本。

### 从 E2B 到必备本地沙箱（取代关系）

`bundled-capabilities-design.md`（基线 `e18b5febf61daf830100351051f216973a0b1599`，设计+计划先提交为 `1ff3719` 再实施）**取代旧设计"E2B 是默认计算前提"**：标准 Web 发行版用 `docker compose up -d` 准备 PostgreSQL/应用/Docling（CPU+OCR）/AKTools/Chromium/本地沙箱，管理员不装 Python/浏览器/OCR 包。E2B 保留为可选兼容，不参与必备能力判定，也不因本地失败自动转云。平台：Linux x86_64 完整验收；Windows Docker Desktop/WSL2 本机验证；macOS 待未来 arm64 验收后再宣称。

### 实施前的现状缺口（动机）

- `llm.service.ts` 仅文本/JSON，无 tools 循环
- `council.service.ts` 五类 researchRequests 无多步循环；simple-council `webResearch=false`
- `research-tools.registry.ts` 只有 13 个工具；工具结果限制约 24KB/12 项
- 交易日历仅 2026 年；budget 无 dispatchKey 幂等

## 实施里程碑与工作包

### 实施计划 P0–P10 / W01–W16（agent-tooling-implementation）

| 阶段 | 工作包 | 内容 | 估算 |
|---|---|---|---|
| P0 | W01 | 契约与依赖验证（含 Backtrader GPL-3.0 核对） | 2–3 人日 |
| P1 | W02–W04 | 运行日志、预算、模型工具循环 | 5–8 |
| P2 | W05 | 连接与 MCP | 4–6 |
| P3 | W06 | 研究与日报集成 | 3–5 |
| P4 | W07–W08 | 产物与金融数据（1000+ 行 fixture，preview 12 行） | 3–5 |
| P5 | W09 | 文档解析（20 份样本人工金标） | 3–5 |
| P6 | W10–W11 | 计算与回测（固定 Python 依赖；10 个可手算情景 + Backtrader preload/runonce 固定） | 5–8 |
| P7 | W12–W13 | 搜索抓取与浏览器（中英各 15 题；虚构站点） | 4–6 |
| P8 | W14 | 应用连接与写入（Composio 15 分钟预览） | 4–6 |
| P9 | W15 | Deep Agents 后端（只读研究模式） | 3–5 |
| P10 | W16 | 完整评测与交付（A01–A25 证据表） | 3–5 |

合计约 **39–62 工程人日 ≈ 串行 8–13 工作周**；审阅节点 P0 / P3 / P6+P8 / P10。

范围→工作包→验收交付映射（计划原文）：R01→W01–04/W06→A01–07/A16；R02→W05→A08–10；R03→W07–08→A11/12/17；R04→W07/W09→A13/17；R05→W10–11→A14/15/17；R06→W12→A18；R07→W12→A09/17/18；R08→W13→A09/17/19；R09→W14→A20–22；R10→W06–11/W16→A12/17/23；R11→W02–06/W16→A03–07/A24；R12→W15→A25。

验收矩阵（A01–A25 覆盖 R01–R12）：A01 两轮工具+最终回答；A02 同 key 重试改参（两 worker）；A03 3 次模型调用=3 dispatch；A04 429/500/坏 JSON/未知 tool 无隐藏重试；A05 三处崩溃；A06 停止/unknown/reparse；A07 预算不足；A08 schema 变化；A09 DNS 重绑定/私网 URL；A10 OAuth 重放；A11 A/H/US 口径；A12 1000+ 行分页；A13 20 份文档金标 ≥98%；A14 20 统计 golden 容差 1e-8；A15 10 回测情景；A16 多账户日报；A17 来源停用删除；A18 中英 15+15 搜索、引用支持率 ≥95%；A19 虚构登录站点；A20 未确认草稿；A21 重复确认；A22 Composio timeout unknown；A23 删除来源后 memory/report/trace；A24 exporter 失败；A25 Deep Agents。能力开关共 8 个。

新增契约文件：`shared/agent-tooling.interface.ts`、`shared/research-runtime.interface.ts`、`shared/research-dataset.interface.ts`、`shared/research-artifact.interface.ts`、`shared/research-compute.interface.ts`；测试件 `server/modules/research-runtime/testing/fake-model.ts`、`fake-tool.ts`、`fake-clock.ts`；文档 `docs/agent-tooling-compatibility.md`。`RuntimeIdentity`：`owner/sessionId/cycleId/revision/memberId/turn/executionAttempt`。`ModelStepResult`：`text/toolCalls(id,toolId,arguments)/finishReason/usage(inputTokens,outputTokens)/providerRequestId`。

### 本地能力套件（bundled-capabilities，六任务）

- Task1 本地沙箱协议 [x]：`workers/sandbox/`（broker+Dockerfiles+tests）、`workers/analytics/` entrypoint、`server/modules/research-compute/` provider adapter、`shared/research-compute.interface.ts`、migration after 58；同 job id 复用 receipt/改 payload 冲突/无调用者 image-path-mount-command/network=none 非 root 资源限制/取消超时未知迟到保留身份。
- Task2 托管能力契约 [x]：`shared/tool-capabilities.interface.ts`、`server/modules/tool-capabilities/`、`tool-connections/`、`data-library/providers/`；准备 vs 授权分离/owner 隔离/重复 bootstrap 不重复 AKTools/revoked 保持/unchanged discovery 不重置/change catalog candidate 不可 dispatch；AKTools 固定 facade 只接受有界结构化查询字段 + 明确公开联网授权。
- Task3 可复现打包 [x]：`Dockerfile`、`docker-compose.yml`、`workers/documents/`、`deploy/release-CI`、`.env.example`；Docling CPU+OCR 断网通过；release manifest 从实际 image ID/digest 生成，匿名拉取门，不发明 arm64 测试。
- Task4 UI [x]：`client/src/features/tool-connections/`；四卡真实准备/授权状态；自定义 MCP 保存做一次 metadata discovery 不自动启用；1440/390px 中英文。
- Task5 持久化/更新/知识 [x]：`server/modules/system-update/`；更新备份用虚构 DB/artifacts/keys；五图流程审阅；`npm run test:architecture/test:context/check:context/lint/build`。
- Task6 验收/合并/部署 [x] 部分完成：全套件隔离 PG16 跑完、独立审阅无 P1/P2；剩余门见「未验收项」。

### 配套工作流

- **source-host 工具恢复**（`2026-11-11-source-host-tools-recovery.md`，基线 `0d88fc4f` PR94）：两个故障——(1) Docker Desktop 29 下 Docling/broker 无有效发布端口（仅内网 tools 网络）；(2) 官方 MCP client 取消非空 HTTP202 通知体时，Transform→`Readable.toWeb` bridge 在 Node 24.16 崩溃。方案：Docling/broker 保持内网，source-host 专用 relay 只发布两个固定 loopback 端口（docling:5002、sandbox:8093），替换为受保护生命周期。
- **浏览器来源采集**（`browser-source-implementation.md`，基线 `fa4a5922`，分支 `codex/browser-source-collector`，上个版本 server 1010/client 443）：四个工作包——浏览器引擎与出口（runtime agent）、持久化与 API（migration 51，integration agent）、Figma 先行 UI（design/frontend agent）、Agent 工具与交付（root）。

## 关键验收结论

以下均为各 validation 文档中**真实执行过的数字/通过项**；未验收项逐条列在「未验收项与限制」。

### 运行层与连接层（agent-tooling-validation，W01–W06）

- W01–W04 [x]：共享契约 / AI SDK 单步 / 持久化 run-step-invocation / 事务预算唯一派发；未做真实模型账号探测。
- W05 [x]：官方 MCP SDK、加密连接、不可变目录、精确版本启用、PKCE-OAuth；真实账号与 OAuth 服务尚未联调；禁止任意 stdio。
- W06 [x]：Council/日报工具循环、冻结持仓现金与数据内容版本、成员私有证据、审批-未知-重解析恢复界面；阅读记录不重发，研究不直接应用策略或写账本。
- 验证方式：破坏性测试只用可丢弃 PostgreSQL16；供应商网络/OAuth/模型写入用假传输；浏览器采集用隔离 HTTPS 夹具；实际 Python 库 **26 项测试通过**、旧 Python Agent **16 项通过**；浏览器 1440/390px 中英文检查；Windows POSIX 专属用例按平台跳过；并发全套曾使 memory-race 60 秒父用例超时，须低负载重跑；未用个人持仓触发付费研究。

### 产物、金融与文档（W07–W09）

- W07–W08 [x]：私有产物、完整不可变数据集、AKTools/Tushare 查询有界摘要；完整 FX/公司行动/历史股票池/跨市场覆盖未完成供应商验收。
- W09 [x]：Docling/MinerU 持久化异步适配器、PDF 页元素定位、DOCX 段落表格定位、迟到回执与孤儿文件清理；本机未装实际引擎、20 份合成金标与 Linux 哈希依赖锁已准备（后续由套件验收补上真实引擎证据，见下）。

### 计算与回测（W10–W11）

- [x]：E2B 禁网沙箱适配器、真实 QuantStats/Backtrader 固定模板、价格→收益转换、产物；**validated 回测仅两个固定单证券模板**；真实 E2B 未连通（后被本地沙箱取代）。

### 搜索、抓取与浏览器（W12–W13）

- [x]：Tavily/Exa/Firecrawl/Composio 假传输契约、真实 Chromium 公网出口/匿名会话/页面预算/截图产物；搜索中英各 15 题质量测量未运行；Browserbase 未登记可用后端。

### 外部写入与 Deep Agents（W14–W15）

- W14 [x]：可编辑完整外部操作预览、版本-hash 失效、确认派发分离、唯一执行权、未知不重试；没有向真实邮箱/笔记应用写入。
- W15 [x]：真实 Deep Agents 只读 driver 共用派发预算、加密 checkpoint 恢复；不开放隐式文件系统/子代理/全局记忆；真实质量/耗时/金额比较未测量。

### 套件整体验收（bundled-capabilities-validation，PR94，基线 e18b5fe）

- 本地 Docker 沙箱真实 Engine 套件 **1/1 通过、零跳过、152.181 s**（nonroot/network/rootfs/socket/凭据/跨任务隔离 + 真实 QuantStats 与 Backtrader + PID/内存限制 + 输出 + symlink 拒绝 + 超时取消重启；broker 组件验收通过）。
- 计算持久化 **30/30 零跳过**（queued replay 保留原 grant/provider/image/source-policy 身份，revoke 后禁止 dispatch）。
- 文档引擎实际 Docling CPU 离线语料：**20/20 解析/拒绝**，**40/40 期望字段字面量命中 lossless JSON**、**39/40 命中 Markdown**（一个 header 被归为 page_header），中文扫描 **4/4**。
- AKTools 实际 MCP initialize/schema + **7 条公开历史行**，禁用操作被拒。
- 浏览器：实际非 root 沙箱 Chromium 动态 JS 通过（精确 Compose security profile）。
- 前端 **466/466 零跳过**：激活/自定义连接旅程 + 1440/390px 中英文通过；英文 model-verification nowrap 溢出修复后 content width = scroll width（335px 移动 / 877px 桌面）。
- context **15/15**、architecture **9/9**。
- 初始 CI（`90029f3`）1257 tests / 1248 pass / 9 fail（8 个为新增 scope 字段后的 fixture exact-object 断言，身份与 scope 分开断言；1 个 private-library 权限回归已修正生产 grant fence）；Python agent 16/16、analytics 26/26。
- 首个真实账号验收（空卷项目 `squabble-bundle-acceptance-20261111`，虚构账号真实浏览器 127.0.0.1:54831 无 API 拦截）：4 张卡初始需授权，一次推荐激活点击全启用；用户未输入内部 endpoint/版本/schema；无模型探测；授权与凭据在应用替换后存活。
- 合成 MCP 仅本部署注册：保存自动发现零业务调用；显式 catalog 选择 + read-effect + 公开数据授权启用一次 echo 调用一个 receipt；无效参数/篡改 schema 身份不 dispatch；相同 catalog 再发现保留 revision 与 grant；改远端 schema 拒绝原冻结调用 `TOOL_RECONFIRMATION_REQUIRED`、零业务调用、清空允许工具显示候选差异；UI 显式批准新版后 UI 断开；真实 app-only 重启后两新服务实例拒绝旧 descriptor，连接保持未配置 revision5，无业务/网络请求；合成 server 进程保留，tools/call 全程恰好 1 次。
- owner API 流程：上传 `10-printed-label.pdf` 真实离线 Docling 解析，普通库搜索找到 Markdown 遗漏的 'Revenue 40'；locator 保留 physical page1 与原始 `#/texts/0` bbox/页面尺寸；公开 AKTools 请求保存 7 条未复权历史行不可变 dataset；首个统计 job 显式失败并确认终止（上游 midnight 时间戳格式不被价格模板接受），receipt 保留、不记为通过；窄修复后 **37/37 pinned analytics 测试通过**；worker 镜像变更后旧 grant 需 review、stale-manifest 请求创建零 job，新 manifest UI 显式批准；hash 验证 dataset 在本地 worker（sha256:21f35603…）成功、确认终止、5 个 hash 验证 artifacts；7 价格行 → 6 个观测收益；无交易日历/币种 → coverage 部分，年化收益/波动/Sharpe/Sortino 保持 null、不填缺失值。
- 最终测试 app 镜像 `sha256:8d326cd6ea9335d88a7b19d85f3403ca459df360d0d0b4c9d0e69be0850661ff`，构建上下文 hash `461419b8c3dcd074c1fbb3dd4602959d866ecb7179a821816325df42aa7f4c40` 覆盖 1493 文件（对比 clean commit `be7a16815918ef80ba15c6677660c84b63e7bc80`）；owner 审计 38 个 portfolio/paper/strategy/holding 表匹配、6 个 model/usage 表全零行；浏览器采集同步 1 个匿名公开页 acquisition=browser-rendered、1 节 1289 UTF-8 字节。独立审阅 final delta 无 P1/P2；部署契约 7/7、document provenance 6/6、analytics 日期处理 14/14。
- 最终 CI（head `830494f8fab7e63b2f9462b1783398e681d12310`，run 42998097308）：server 1263/1263、client 466/466、native 181/181、memory 99/99、dev 9/9、context 15/15、architecture 9/9、browser preflight 3/3、Python agent 16/16、analytics 37/37，全零失败零跳过；Docker contracts 7/7、gateway 3/3。

### 打包与注册表证据（bundle-packaging-validation，分支 codex/bundled-tools-local-sandbox）

- 环境：Docker Desktop Engine linux/amd64 cgroup v2、8 CPU、16,513,085,440 bytes RAM；fixtures 为 `workers/documents/fixtures` 合成 CC0。
- 版本锁定：Docling Serve **1.38.2**（digest `sha256:7b31b3c2…`，压缩层 2,217,541,197 bytes，上游源 `9c058dbb…`）；Playwright **1.65.0** Noble amd64（`sha256:bc4fbb32…`，1,002,814,156 bytes）；AKTools **0.1.5 + AKShare 1.20.37**（Python 3.12 Linux amd64，Docker 实际装 60 个锁定包）；Docling 本地镜像（`sha256:8470a752…`，7,566,255,830 bytes）Python 3.12.15 / Torch 2.14.1+cpu / torchvision 0.29.1+cpu / RapidOCR 3.10.0 / ONNX Runtime 1.31.0 / Docling Serve 1.38.2；应用镜像 Node 24.22.2 + pg_dump 16.15（`sha256:fc20c82c…`，4,436,269,962 bytes，544 锁定包）；Chromium 158.0.8127.18（uid1000、chromiumSandbox:true、no-new-privileges、256 MiB shm；加 cap-drop ALL 时上游 profile 条件 chroot 拒绝，实际 Compose 保留默认 bounding capability 集通过）。
- 修复：一处 ECONNRESET 通过 Dockerfile 选官方 npm `replace-registry-host=always` 修复（无版本变化）；`ocr_lang` 需 `iso:zh` 而非 `zh-Hans`。
- 部署契约 `node --test deploy/bundle-contract.spec.cjs deploy/release-bundle.spec.cjs`：4 passed（初 RED）；`test_bundle_gateway.py` 3 passed；后扩展为打包契约 7/7 Node + 3/3 Python gateway。
- AKTools 本地镜像（`sha256:52947b6f…`，637,190,379 bytes；只读 uid1000、cap-drop ALL、1 CPU/768 MiB/128 PIDs）：initialize 返回 0.1.5，tools/list 恰为 get_data schema，任意函数被 JSON-RPC -32602 拒绝；`stock_zh_a_hist` 样本 600000（2025-01-02~2025-01-10）返回 7 rows、12 原始列、1.876 秒、查询后内存 214.9 MiB。
- Docling：模型清单 103 文件 / 912,467,185 bytes（SHA-256 `968d35d6…`）；`deploy/document-smoke.py` **20/20 解析/拒绝**（17 有效 PDF/DOCX）、**40/40 lossless / 39/40 Markdown**、69.243 s（结果 `workers/documents/acceptance.linux-amd64.jsonl`）；内存峰值 2,199,445,504 bytes、常驻 1.649 GiB；首个冷中文扫描 13.192 s、4/4 字面量。
- fresh 项目：初始 `--wait` 因内存压力 app 曾 unhealthy（记录为初始失败），后全部健康 `/api/health {"status":"ok"}`，配置 120 秒启动宽限；`squabble-bundle-fresh-20261111` Compose up `--wait --wait-timeout 300` exit 0，最后健康转换 Docling 36.955 s。
- relay：用既有 broker Node 镜像做固定目标 TCP relay（仅 loopback、固定 docling:5002 与 sandbox:8093），uid1000 只读 capless、64 MiB、64 PIDs、每端口 32 连接、64 KiB 水印、5 秒连接/30 秒空闲/120 秒总连接截止；relay 测试先 RED，修正后 **6/6 relay + 13/13 组合打包契约**；`squabble-relay-acceptance-20261111` 通过，loopback 54842/54843/54844 真实健康、未认证 401；relay cgroup 67,108,864 bytes、峰值 28,557,312 bytes。
- 缓存足迹：6 个缓存镜像、73 唯一层、10,192,883,712 bytes；containerd 足迹 14,070,760,907 bytes；归档 job 要求 ≥25 GiB 空闲磁盘（GitHub 标准 runner 仅 14 GB），低于阈值才允许删除 `/usr/local/lib/android`。

### source-host 故障与修复（source-host-tools-validation，PR94）

- 根因：原生 Windows server 先健康、MCP 元数据刷新时崩溃——Node 24.16 `Transform`/`Readable.toWeb` 在官方 MCP client 取消后入队缓冲 HTTP202 通知字节，合成 localhost fixture 复现 `ERR_INVALID_STATE`。
- 修复：替换体用受保护 async reads/背压/显式 HTTP destruction；保留 DNS pinning/私网 allowlist/TLS 校验/重定向拒绝/响应边界；无全局异常处理器/忽略崩溃/Node patch。
- 完成检查：transport/MCP 回归 **10/10**（native Node 24.16）+ **10/10**（Node 24.22 镜像，零跳过；取消回归修复前失败）；relay 回归 **6/6**；组合部署套件 **13/13**；gateway Python **3/3**；真实 Docker Desktop source-host 测试（独立虚构项目）Compose up --wait exit 0、真实 loopback document/broker/AKTools 元数据可达、私有路径拒绝缺授权、无计算 job；Docling/broker 无有效宿主端口/默认网关、出站 Internet 探测失败；relay uid1000 64 MiB cgroup 峰值 28,557,312 bytes；3 次真实 AKTools initialize/list-only 发现安全处理非空 202 体（无业务工具/模型/DB/授权变更）；独立审阅 transport+relay 无 P1/P2；architecture 9/9、contributor helpers 15/15、context 结构校验通过；五图只有 system source-host 路由变化。

### 浏览器来源采集（browser-source-implementation）

- 数据/HTTP/upgrade/Agent 回归组 **16 tests、零跳过**；最终 browser/network 套件 **20 passed、零跳过**；preflight helper **3 passed**；独立审阅复检新用例，无剩余 P1/P2。
- 独立审阅验证：暂停/改版/权限撤销约 1 秒内到达活动采集、无版本提交；生产浏览器/代理路径读取公开 IANA 页面。修复了 source-binding 缺口（第三方登录态与跨 origin 最终导航）：只恢复来源适用的 cookies 与精确来源 origin、原子捕获内容 URL、状态捕获后复检最终 origin；确认与读取期间的强制导航被拒绝，正常同源重定向仍支持。
- 生命周期复检：正常 GET 会话轮换丢失——已确认会话的读取现返回刷新的来源过滤状态，服务端脱敏新旧值、加密刷新并只在成功 fenced 捕获事务内提交；匿名读取不能建立持久登录或改手动连接时间戳；阻断的版本插入期间取消会回滚全部捕获写入后再独立 fenced 取消结算；测试证明 V1→V2→V3 连续捕获、stale-worker 拒绝、断开/删除/取消保护、无刷新状态泄漏进版本或模型结果。
- 并发用例：一个既有测试把 1.5 秒启动期限当作并行断言，满载本地运行超时；加入 10 秒死锁保护与定时器清理后聚焦重跑通过。
- Linux CI：初始浏览器启动失败 + fixture 无界就绪循环——就绪传播启动拒绝并加期限、fixture 与生产共用同一完整 Chromium 二进制、独立 preflight 保留真实启动原因；仅当内核限制启用且确认 AppArmor 命名空间拒绝时，才在 GitHub runner 上允许 exact-binary userns profile（遵循 Chromium 官方指引），永不关闭 Chromium sandbox。
- 公开无凭据 Pickalphas 运行读取到达真实登录页并返回 `NEEDS_AUTH`（替代先前静态抓取超时）；这不验证已认证订阅文章。

### 上游研究（clowder-agent-and-tool-research，核对日期 2026-11-02）

- 六种 Agent（官网 i18n.js 源码列出）：Claude Code / Codex / Gemini CLI / Antigravity / opencode / Kimi（README 只列四种，不能只看 README）；核心是统一 AgentService + 各供应商运行适配器。
- "60+" = 60+ built-in skills（非模型接口/服务数）；主干顶层 `cat-cafe-skills/*/SKILL.md` 统计为 **59**；manifest.yaml 记录分类/描述/triggers/not_for/output/next/MCP 依赖；F038 BM25/regex 延迟检索仍为待推进。
- MCP 侧：`canonical-server-tools.ts` 汇集工具、`server-toolsets.ts` 注册 registerTool（身份/取消/只读过滤/输出大小）、`capability-orchestrator` 管 capabilities.json、`provider-mcp-config.ts` 按成员/工作区/范围/启用状态生成配置。
- Squabble 应用沿用七种 Agent 每角色模型/推理设置；投研技能可复用"简短索引→按需读技能→有权限工具"；开发流程技能不批量复制进产品。
- 豆包：`Fullstop000/doubao-cli` 社区连接器（非官方 CLI），npm 0.23.2，Windows 隔离配置验证（版本/headless 查询/未登录检测可运行，不等于已登录验收）；任务保存 conversationId/runId，取消请求上游停止，超时不确定不自动重复提交；登录由用户在原生终端完成。

## 关键数据与契约

### 预算与唯一派发

- 每个模型 HTTP 调用只计一次；reserve 以 owner+dispatchKey 唯一，同 key 同 requestHash 复用 receipt、改参冲突；available = limit − settled − inflight；未知费用保留至供应商事实；SDK retry=0。
- 初始技术上限：每成员最多 **6 模型 step**、每 step 最多 **4 工具请求**、全 run 最多 **24 次工具执行**、同 owner 同时最多 **2 个运行中研究成员**、同 run 最多 **2 个并发只读工具**；只读工具最多 2 并发、单连接最多 1 在途。

### 权限与边界

- 工具 effect 三态 `read / compute / external_write`；禁止 provider-executed writes；fallback 独立新派发。
- 冻结：启动冻结 catalog/schema hash/连接修订/权限/价格版本；old `ResearchToolResult.asOf:string` 保留兼容，新工具 `timing.observedAt/completedAt` + `provenance.dataAsOf:string|null`。
- 浏览器工具 `read_browser_source({sourceId})`：只接受已启用/owned/已保存的来源，不接受 URL/profile/password/cookies/浏览器端点；返回有界摘录 + 精确 source/version 引用，记录为真实工具调用；不能启用全局 MCP 工具或操作无限制浏览器。
- Composio 写入：生成草稿→持久化预览→确认同 payloadHash→最终复验→单次 dispatch→保存回执；禁用 workbench/bash 工具；状态未知停止自动重试。

### 连接与会话

- 表：`agent_tool_connections`、`agent_tool_catalog_versions`（快照不可变）、`agent_runtime_runs`（完整身份唯一）、`agent_runtime_steps`（run+step 唯一）、`agent_tool_invocations`（run+step+toolCallId 唯一）、`agent_tool_budget_reservations`（invocation 唯一）、`research_dataset_versions`、`research_artifacts`、`agent_action_previews`（默认预览有效期 15 分钟）；迁移 `53_agent_tool_runtime.sql`、`54_research_artifacts.sql`、`55_tool_actions.sql`（浏览器来源采集另用 migration 51）。
- 能力准备与授权三态：installation（starting/ready/unavailable）、catalog（verified/changed/unavailable）、grant（disabled/enabled/review_required）；`discover()` 相同目录 no-op 不重置授权。
- 浏览器登录态：服务端加密保存会话状态（cookies/local storage 用实例既有 settings key 单独加密），不返回 API/不发模型/不存为文章内容；断开清除当前存储、历史备份保留匹配加密数据（DB+settings key 一起保留）；OAuth 登录可能临时访问其他公开站点但确认与采集必须在配置 origin 结束；第三方登录态丢弃、跨 origin 导航使采集失效；登录与采集分离生命周期；提交需匹配 source revision/当前 job/未过期 lease token；采集总期限低于既有 90 秒 lease。
- 采集出口：短生命周期认证公网出口代理 + 验证地址连接 + 有界浏览器生命周期/请求/字节 + 上下文隔离；私有地址/不安全协议端口/带凭据导航 URL 被阻断；TLS 验证与沙箱保持开启；service workers 与非代理传输禁用；代理凭据保持内部。HTTP Basic 不能替代表单登录。

### 运行日志与状态机

- 状态机：queued→running→waiting_approval（编辑自环更新 revision/hash）→cancelled|running；running→provider_unknown（已发送结果未知）→result_received|failed|settled_unknown（关闭但费用未知）；result_received→accepted|failed|cancelled；failed 仅已存响应可本地 reparse 加审计、不重发；cancelling→cancelled|provider_unknown。
- 恢复字段 `runtimeTarget:{runId, stepId?, expectedCursor}` 加入 `shared/research-execution.interface.ts`。

### 文档、计算与回测契约

- 文档：Docling 受控侧服务、解析器不持凭据；每次提取固定 originalHash/extractor 版本/语言/OCR 选项；PDF 页码从 1 开始 + pageLabel + elementId + bbox；DOCX 用稳定 elementId 定位；OCR 置信度不可用标 unknown；产物 effectiveDataClasses=输入并集、允许用途取交集。
- 计算：E2B 默认允许外网但部署模板必须显式关闭；不注入生产凭据；QuantStats 不是回测撮合引擎；固定模板标 `reproduced-calculation`、自由代码标 `exploratory`；本地沙箱容器固定镜像、非 root、network=none、read-only rootfs、cap-drop ALL、no-new-privileges、默认 seccomp；默认并发 1、单任务最多 120 秒、输入 32 MiB、输出 16 MiB；专用 broker 持 Docker socket（应用不挂 socket）、只接受固定作业协议。
- 回测约束 7 条（按 availableAt 而非报告期、不复权可成交价、不填零收益、validated 只允许固定审查模板等）。
- 金融规范字段：instrument / source-provider-operation / observedAt-fetchedAt / asOf-marketDate / reportPeriod-announcedAt-availableAt / currency-unit-scale / accountingBasis-consolidation / adjustment-corporateActions / coverage-missing-delayed / license-retention；至少验收 A 股日线复权、港股财报、SEC 财报、公告更正、交易日历、汇率、估值、组合多证券。

### API 面

- `/api/tool-connections`（CRUD+discover+probe+authorize+disconnect）；`/api/research-conversations/:id/tool-runs`；`/api/research-tool-runs/:id`（+`actions/:actionId/confirm|reject`）；`/api/research-artifacts/:id`。
- 测试命令模式：`node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test ...`；`npm run type:check/test:architecture/test:wiring/test:server/test:client/test:browser/test:telemetry/test:memory-eval/test:context/check:context/build:web`；`uv run --project workers/analytics pytest ...`；测试库 env（`BUDGET_TEST_DATABASE_URL`/`COUNCIL_TEST_DATABASE_URL`/`RESEARCH_TEST_DATABASE_URL` 等 10 个）用临时 PostgreSQL16、虚构账户、假 exporter。

## 未验收项与限制

> "代码存在 ≠ 真实连通"：以下均为明确的未验收/边界项，不得当作已可用能力。

- **模型与供应商**：未用真实模型账号探测；官方 MCP/OAuth 服务（Tavily/Exa/Firecrawl/Browserbase/Composio/Deep Agents 等）真实账号未联调；Browserbase 未登记可用后端；Deep Agents 的真实质量/耗时/金额比较未测量；搜索中英各 15 题引用支持率 ≥95% 质量测量未运行。
- **外部写入**：没有向真实邮箱/笔记应用写入（Composio 仅假传输契约）。
- **E2B**：真实 E2B 未连通（其默认计算地位已被本地沙箱取代，E2B 仅保留可选兼容）。
- **文档金标**：20 份人工金标表格字段准确率 ≥98%（A13）与计算 20 golden 容差 1e-8（A14）、回测 10 可手算情景（A15）未按原指标单独记录结果；已测得的是真实 Docling 离线语料 20/20 解析、40/40（lossless）/39/40（Markdown）字段字面量命中；validated 回测仅两个固定单证券模板。
- **供应商数据**：完整 FX/公司行动/历史股票池/跨市场覆盖未完成供应商验收；交易日历仅 2026 年（设计基线）。
- **浏览器**：真实站点人工登录与真实内容需用户正常登录后单独验收；Pickalphas 到达登录页返回 `NEEDS_AUTH`，未验证已认证订阅文章；默认 Alpine 应用镜像不含 Chromium（源码安装需 `npx playwright install chromium`），容器无浏览器时报告 unavailable 而非假装成功。
- **source-host 剩余门**：recovery PR 必需检查、合并 tested head、从合并源更新 stopped 的 native 3192 候选服务、重复实际本地元数据准备/进程稳定检查、保留匹配备份与 owner grants；无付费模型探测/个人研究 smoke。
- **套件剩余门（Task6 未全关）**：最终 workflow/文档 commit 的必需 CI、exact tested-head PR 合并、发布固定镜像归档 + 匿名 digest 验证、匹配备份/隔离恢复/本地部署/只读健康检查；公开发布归档验证（release workflow 冷启动、SANDBOX_REAL_TESTS=1 完整沙箱耗尽/恢复套件）为待办。
- **平台**：fixture 仅虚构账号/自写文档/明确公开金融样本；未用个人持仓做模型调用/写入/删除/交易；Windows Docker Desktop Linux amd64 已执行，macOS/arm64/desktop 安装器资格为未来工作。
- **本地 relay 测试不替代标准新用户验收**；本地 source-host 测试仅用独立虚构项目。
- 历史文档是过去设计/验证运行的证据，不是当前 checkout 的承诺（docs/README.md「Retained workflows and history」同口径）。

相关归档：Agent 工具体系审查处理记录见 [03-product-history](../03-product-history/README.md)；V5 数据中心/浏览器来源设计的更早版本文档见 [04-future-designs](../04-future-designs/README.md)。

## 源文档

以下相对仓库根 `docs/` 的原文件已提炼并删除（12 份）：

- `docs/superpowers/specs/2026-11-11-agent-tooling-design.md`（Agent 工具体系设计）
- `docs/superpowers/plans/2026-11-11-agent-tooling-implementation.md`（实施计划，P0–P10/W01–W16）
- `docs/agent-tooling-validation.md`（工具体系验收记录，PR93）
- `docs/superpowers/specs/2026-11-11-bundled-capabilities-design.md`（本地能力套件设计，取代 E2B 默认）
- `docs/superpowers/plans/2026-11-11-bundled-capabilities.md`（套件实施计划，Task1–6）
- `docs/bundled-capabilities-validation.md`（套件验收记录，PR94）
- `docs/bundle-packaging-validation.md`（打包与注册表验收记录）
- `docs/superpowers/plans/2026-11-11-source-host-tools-recovery.md`（source-host 恢复计划）
- `docs/source-host-tools-validation.md`（source-host 恢复验收记录，PR94）
- `docs/clowder-agent-and-tool-research.md`（上游 Clowder/豆包工具研究）
- `docs/browser-source-figma.md`（浏览器采集 UI 设计稿，2026-11-10）
- `docs/browser-source-implementation.md`（浏览器来源采集实施计划）

另保留为当前产品文档（未删除）：`docs/browser-source-collection.md`（网站订阅浏览器采集操作指南，被 docs/privacy、docs/self-hosting、docs/research-data-workspace 引用为运行时限制说明）。
