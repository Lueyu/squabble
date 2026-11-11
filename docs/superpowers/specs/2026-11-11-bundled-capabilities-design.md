# 开箱工具与必备本地沙箱详细设计

日期：2026-11-11。源码基线：`e18b5febf61daf830100351051f216973a0b1599`。
用户已批准先成文、随后实施、验证、PR 合并和本地部署。本设计替代旧设计中“E2B 是默认计算前提”的部署选择；原有研究状态机、来源墓碑、证据隔离、审批与未知费用规则继续适用。

## 1. 用户可观察结果

标准 Web 发行版通过一次 `docker compose up -d` 准备 PostgreSQL、应用、Docling CPU/OCR、AKTools、Chromium 和本地沙箱。管理员不安装 Python、浏览器、OCR 包，不编辑内部服务地址，不选工具 schema 版本。Docker 兼容 Linux 容器运行时是宿主前置条件。

首次进入“工具与能力”显示真实准备状态；一屏授权推荐能力。安装、发现和业务授权分离。已有用户不重新填写模型凭据；未配置模型也可使用资料上传/解析及确定性工具。模型探测仍显式说明最多两次付费请求。云搜索/应用连接保留按需凭据和授权；不影响基础本地能力。

默认四包：资料阅读（Docling、现有资料检索）；金融查询（受限 AKTools 操作）；网页阅读（匿名 Chromium）；定量分析（固定模板及受限探索代码的独立容器）。MinerU 为增强配置，默认不启动第二解析器。公开网页与 AKTools 需要公网，界面称“在部署服务器运行”，不能暗示全部离线或访问用户电脑登录状态。

## 2. 方案选择与跨平台

选择 Docker 兼容 Linux 容器作为统一后端。固定模板与模型生成的 Python 均在每任务全新容器运行；不将长期 Python 服务或普通 subprocess 当作任意代码沙箱。E2B 保留既有可选连接兼容，不参与必备能力准备判定，不因本地失败自动转云。

| 平台 | 运行方式 | 本轮交付边界 |
|---|---|---|
| Linux x86_64 | Docker Engine + Compose | 标准发行及完整实际验收 |
| Windows x86_64 | Docker Desktop Linux containers / WSL2 | 本机实际验证，宿主无需 Python |
| macOS Intel / Apple Silicon | Docker Desktop Linux VM；未来可验证兼容 runtime | 复用 HTTP 作业协议；arm64 依赖锁、模型和镜像分别验收后才宣称原生支持 |
| 未来 Windows/macOS Desktop | Electron 后端连接同一部署级沙箱服务 | 本轮记录探测、启动、状态和停止契约，不恢复桌面安装包发布 |

未来桌面启动器探测 Engine、Linux containers、架构、资源控制与整套版本；未准备则显示具体前置条件并提供安装说明，不降级为宿主执行 Python。Docker Desktop 的安装、虚拟化和用户许可接受仍属于宿主前置条件。避免将“一个安装器完全无需虚拟化权限”作为本轮承诺。

官方依据：[Windows](https://docs.docker.com/desktop/setup/install/windows-install/)、[macOS](https://docs.docker.com/desktop/setup/install/mac-install/)、[资源限制](https://docs.docker.com/engine/containers/resource_constraints/)。本机只读检查已确认 Windows/WSL2 Linux amd64、cgroup v2、内存/CPU/PID 限制可用；这不替代实际沙箱测试。

## 3. 必备沙箱边界

应用不挂 Docker socket。专用 broker 持有 socket，只接受固定作业协议，不提供 Docker 代理、宿主路径、镜像、挂载、命令或网络参数。broker 凭据自动产生并持久化，生产不使用示例密钥。Compose 内网访问；源码部署仅绑定 loopback，并使用部署级认证。broker 本身属于高权限受信部署组件，不能声称 Docker socket 挂载是低权限。

输入：jobId、协议版本、完整 manifest、限定名称的 dataset-N.json/code.py、内容 hash、限额。作业身份幂等绑定内容；同一身份不同内容冲突。broker 在执行前持久化创建意图，容器名称/标签绑定随机部署实例和不可猜测作业身份；超时响应可查询原身份，不再次创建新作业。

容器：固定已准备镜像及实际 image ID；非 root；network=none；read-only rootfs；cap-drop ALL；no-new-privileges；默认 seccomp；CPU/内存/PID/临时空间/时长上限；无宿主路径、Docker socket、应用凭据或其他任务卷；只接受当前任务数据。输入、输出和日志均有总字节上限，拒绝路径穿越、符号链接和异常文件类型。任意代码只改变本任务临时文件；模型不控制隔离参数。

执行端固定入口调用现有 analytics CLI。可信固定模板与探索模式分别标记；探索结果不能升级为 validated backtest。输入来源、数据版本、availableAt、价格/日历/规则、许可和来源撤销检查全部复用，不因更换 provider 放宽。

每个作业执行前回传可恢复容器身份；取消、父任务暂停、来源撤销和进程退出阻止接受结果并触发终止。broker 有独立截止时间清理及重启清理；应用保留已知身份、未知状态及终止确认，检查/清理只查询或终止原资源。结果成功必须有输出 hash 与终止确认。恢复不重新执行。不同 provider 的旧作业按原 provider 清理，不把旧 E2B ID 交给本地 Docker。

默认并发 1、单任务最多 120 秒、输入 32 MiB、输出 16 MiB；宿主配额由部署清单限定。资源不足和 Engine 不可用显示故障，不静默转本机或付费云。实际镜像资源峰值在验收记录中测量。

## 4. 能力清单与授权

部署级清单记录稳定 pack/service ID、版本、image/model hash、固定 origin、工具 schema/effect、允许业务操作、数据去向与资源要求。不是把文档/浏览器/计算强行包装成 MCP。用户级授权记录 pack ID、清单授权版本、资料类别、启停及修订；新建用户只自动准备连接，不自动授予业务调用。

状态分别计算 installation（starting/ready/unavailable）、catalog（verified/changed/unavailable）、grant（disabled/enabled/review_required）。只有所需组件实际准备且当前授权有效，才显示可用。设置 GET 只读缓存；启动协调和显式保存动作执行有界元数据检查，不能运行模型、搜索、金融查询或解析用户资料。

现 discover() 即使 hash 不变也清空授权，必须修正：相同规范目录 no-op，只更新检查时间；变化存 candidate，旧 active 保持独立，不发布未批准的工具。已有工具 schema/effect/服务身份/外发目的地变化暂停受影响权限并要求确认；新增工具不自动授权。用户停用是持久状态，自动协调不能复活。运行中的 frozen catalog 继续遵守当前权限复验，不在后台改写它。

托管 AKTools 每 owner 绑定稳定连接，不能在重复启动时产生多个匹配连接。金融查询由服务端固定接口构造最小请求，仅包含证券、市场、日期、操作等已授权字段，声明查询兴趣会外发；不开放任意 AKShare 函数/参数、不把整个研究上下文分类降级。现有通用 MCP 的资料限制继续适用。

匿名网页能力的公开联网授权不包含私有资料外发。含持仓、私有资料或应用数据的研究，仅可从运行创建时冻结的公开证据 URL 发起导航，必须逐字匹配规范 URL，不能由模型附加路径或查询参数；冻结用户上下文、资料库引用和带凭据 URL 不进入该清单。后续只可读取、翻页或展开网页自身返回的目标。纯公开研究保留通常的公网 URL 导航，既有认证采集仍使用独立的已保存来源与会话授权。运行中新增私有来源会收紧现有浏览会话；工具参数或 HTTP 客户端不能自行提交授权 URL 清单。

本地计算使用 research/local-processing 许可；云计算额外校验目的地 egress 权限。撤销 source/owner 权限在 dispatch、poll、artifact acceptance 复查。预算默认本地页数/秒数/调用数限额，云付费工具默认关闭；未知单价不声称金额硬上限。

## 5. 界面及自定义工具

工具页首先显示四张业务卡和实际状态。一屏可启用推荐本地能力并确认公开联网查询范围，私有资料发往模型的权限独立说明。运行器、端口、schema 和版本归入高级详情。外部写入依旧逐次精确预览，能力包授权不授权投资执行。

添加工具保留“服务预设”和“自定义 MCP”：预设自动填写端点和审核目录，用户只给密钥/OAuth；自定义保存后有界自动发现，显示真实结果，再确认工具/数据权限。未知 MCP effect 不信任远端只读提示，保守处理。owner 不能通过自定义地址扩大私网访问；管理员扩展精确服务登记。连接失败保留配置与可修复原因，不自动调用业务工具测试。A2A 属于研究 Agent 接入，不混入工具协议。

## 6. 镜像、模型与数据维护

Docling 固定 CPU 路径、中文 OCR 及全部所需模型在构建阶段下载并记录 hash；断网解析作为必过验收。Chromium 与 npm Playwright 版本对应，以非 root 沙箱运行，保留既有公网出口限制；容器默认匿名浏览，已登录采集不假定支持。AKTools 只开放受限 MCP 路径和内部地址。

镜像发布为公开可匿名拉取的发行套件，版本化清单固定精确 image digest。发布前不填写虚构 digest；生成脚本从已构建/推送镜像取得真实 digest。用户不运行 pip/npm install 或模型下载。源码构建覆盖文件供开发使用，默认用户配方只拉取。镜像/权重许可证随版本保存。MinerU 不默认运行，按选定版本许可和模型单独登记。

资料原件、研究产物、broker 作业回执、数据库和密钥持久化到 named volumes/稳定部署目录。工具套件按完整版本更新，不允许 sidecar mutable tag 各自自动漂移。更新备份包含匹配 DB/密钥/原件/产物及文件 hash 清单，隔离恢复检查；禁止 down -v 更新。

## 7. 验收与发布门槛

必须实际执行：全新空卷启动、首次授权、真实数字/中文扫描 PDF/DOCX 解析、真实 Chromium 动态网页采集、公开金融查询、统计及固定回测、探索代码隔离、添加自定义 MCP 后在研究工具路径调用、重启和升级不重置授权。离线测试和 fake transport 不能代替这些真实组件验收。外部行情不可达须记录网络/上游限制，不伪造成功。

安全/恢复覆盖：网络与内网访问拒绝、无应用密钥/宿主挂载、跨任务不可见、路径/大输出拒绝、超时/取消/崩溃清理、broker/app 重启原身份查回、源删除/撤权后迟到结果不发布、模型与云服务调用数为零的准备检查。

重点旅程：用户无手写 endpoint/版本/环境配置完成本地工具使用；自定义 MCP 保存自动发现、最小权限确认、实际调用、目录未变保持授权、目录变更提示差异、停用重启不复活。使用虚构数据及明确公开样例；个人持仓不作付费研究、订单或删除测试。

完成相关单元、数据库集成、真实套件 smoke、双语桌面/移动 UI、fresh/upgrade/replay/restore、architecture/context、完整 lint/build 与必需 CI；独立审查后 PR 合并。部署前重新发现实例身份、匹配备份并恢复验证，保持已有私有数据及其他实例。验收未完成的组件按事实列明，不以“已登记”代替可用。
