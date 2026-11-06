[English](README.md) | 简体中文

<div align="center">

<img src="client/public/logo.svg" width="88" alt="吵股" />

# 吵股 · Squabble

**研究记得住，决定由你做。**

开源投资工作台。
独立研究与反向核查形成每日报告。
有事实依据的频道持续跟进变化，由你拍板。

**美股 · 港股 · A 股** · **中英双语** · **自托管** · **零埋点**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Lueyu/squabble/actions/workflows/ci.yml/badge.svg)](https://github.com/Lueyu/squabble/actions/workflows/ci.yml)
[![桌面版](https://img.shields.io/badge/Desktop-Windows%20%7C%20macOS-blue)](https://github.com/Lueyu/squabble/releases/latest)

</div>

![吵股仪表盘](docs/screenshots/dashboard.png)

## 为什么试试吵股？

看清持仓现在怎样、发生了什么变化、有哪些事情需要你决定。

- **每日研究与轻量频道。** 独立调查与单独的反向核查沉在可阅读报告里。频道提供有来源的短句、可展开证据及单事实追问。[频道使用说明](docs/channel-workbench.md)。
- **按确认策略运行模拟盘。** 复制已记录的持仓和现金，审阅策略后明确应用到模拟盘。当前规则、待应用建议与实际成交分别展示，已有高级工具仍可使用。
- **数据只属于你。** 自托管。零埋点。桌面版和源码本地工作区无需吵股登录，账号模式仍可选用。

## 安装

### 桌面版（Windows / macOS）

1. 打开 [Releases 页面](https://github.com/Lueyu/squabble/releases/latest)。
2. 下载对应系统的安装包（Windows 下 `.exe`，macOS 下 `.dmg`）。
3. 双击安装。内置 PostgreSQL 和全部服务，无需另装任何软件。

安装后吵股会在独立窗口直接打开本地工作区。数据保存在你的电脑上；已有数据会保留，详见[升级与工作区选择说明](docs/self-hosting.zh-CN.md#本地工作区与已有数据)。

### 网页版（Docker）

需要 [Git](https://git-scm.com/downloads) 和 [Docker Desktop](https://docs.docker.com/get-docker/)。

```bash
git clone https://github.com/Lueyu/squabble.git
cd squabble
docker compose up -d
```

打开 **http://localhost:3000**，注册第一个账号。

数据库默认为空。想体验虚构演示数据，改用 `docker compose -f docker-compose.demo.yml up -d --build`。

### 源码运行（开发者）

需要 Node.js 22+ 和 npm 10+。

```bash
git clone https://github.com/Lueyu/squabble.git && cd squabble
npm install
npm run dev
```

首次启动前，按 `.env.example` 在 `.env.local` 中配置 PostgreSQL 连接和私有 `JWT_SECRET`。
看到 `Ready:` 后打开 **http://127.0.0.1:8080**，开发界面从源码加载并支持热更新。
示例启用 `AUTH_MODE=local`，无需吵股登录。保持 `SERVER_HOST=127.0.0.1`、`TRUST_PROXY=false`；需要账号登录时使用 `AUTH_MODE=account`。已有数据和前端来源配置见[开发指南](docs/development.md#local-workspace-mode)。
每次 `npm run dev` 会停止上一次开发会话，清理前后端端口的占用进程树，重新编译后端并刷新 Vite 缓存；按 Ctrl+C 会停止本次会话。
默认端口为 `SERVER_PORT=3000`、`CLIENT_DEV_PORT=8080`，可在 `.env.local` 中修改。前端端口不会自动递增，避免访问到旧实例。

## 它能干什么

| 功能 | 说明 |
|---|---|
| **持仓管理** | 美/港/A 股持仓、现金、盈亏与净值曲线。内置 USD/HKD/CNY 折算。 |
| **AI 研报** | 多空辩论、批评者审视、风控硬门。14 节报告。版本化保留，输掉的论点原文保存。 |
| **研究记忆** | 按版本保存论点、依据、反证、失效条件和时间边界。可查看每次研究实际发送了哪些完整记忆。Agent 审核通过与你的个人确认分别记录。 |
| **模拟炒股** | AI 盯盘 + 硬性风控（日亏损熔断、单笔上限）。支持手动下单和 MCP 代理下单。 |
| **持仓导入** | CSV 自动列映射（5 券商预设）。可一次选择最多 20 张截图，按需删除不需要的图片，再依次交给已连接且支持图片的本地 Agent 或视觉 API 识别；合并、核对并编辑结果后统一确认导入。 |
| **通知推送** | Webhook、Bark、Server酱、邮件、Telegram。每笔成交和风控事件即推。 |

## 简化体验（按开关试用）

在服务端设置 `SQUABBLE_SIMPLE_EXPERIENCE=true`，启用**今日、投研室、AI投资**三个入口。今日合计持仓市值与已确认现金，分别展示当日盈亏、资产变化和外部净资金流；缺少行情、昨收或汇率时保留已知部分，并说明缺项。快速记账和批量导入支持成交、资金流水的 CSV、Excel 及截图，导入前先核对。

今日只展示最新的完整报告，较早报告通过低调的历史入口查阅。完整报告按日期和来源留存，每轮讨论的报告也保留在原会话。研究进行时展开当前公开步骤，完成后收成摘要，手动展开的内容保持展开。报告以清楚的文字阅读，旧的已知 JSON 格式可直接整理，无需重新调用 AI。

新生成的每日持仓研究会单列执行策略草案，写清股票、触发条件、股数或目标总仓位、期限和建议风险边界。可复制文字，或将已归档的准确方案加入可编辑策略草稿，无需再调用 AI 提取。缺资料和本次不交易会明确显示。建议参数不等于市场事实或用户既有授权，应用到模拟盘仍需单独确认。历史报告不会被悄悄补出交易提案；手工修改报告也不会继承隐藏的旧执行条件。

今日的投资策略可以手写，也能从报告加入并修改。保存草稿时旧策略继续运行；审阅执行说明并点击“应用到模拟盘”才整体切换。选择仅作观察策略核对，不调用 AI，也不生成自动买卖条件。AI 整理失败时可查看持久状态和具体原因；确认失败后由用户手动重试，尚在进行中的请求只读取状态，不重复派发。复制当前持仓与已记录现金即可建立独立模拟盘，还可另加虚拟现金。缺少可信估值时先观察，补齐后再开始计算模拟收益。

模拟盘只按你确认的策略交易：明确规则直接检查执行，含义不确定的交 AI 补判，大仓位或高风险交研讨室；新股买入需要两个不同的已核验实际执行来源。策略外机会先讨论、加入草稿，再由你确认。**暂停会停止全部自动买卖，包括保护性退出。**旧账户和成交记录保留；没有用户策略的旧自动账户升级后暂停，待确认策略后再运行。详见[资产、报告与策略使用说明](docs/assets-reports-strategy.md)。

## 连接本地研究 Agent

打开 **设置 → 本地研究 Agent**，即可使用电脑上已安装的 Codex、Claude Code、Gemini CLI、Antigravity、OpenCode、Kimi 或社区豆包 CLI。
在对应终端完成登录后，点击 **连接**。Docker 用户在同一台电脑打开吵股桌面版，
从网页设置发起配对，再在桌面弹窗中确认本地地址。研究期间保持桌面应用开启。
每位成员可选择模型和 Agent 支持的推理选项，也可以沿用原有默认配置。[安装与使用说明](docs/local-agents.md)。

本地工作区模式中的原生 Agent 连接属于这台安装实例，不绑定吵股账号；服务商 CLI 登录独立保留。

兼容版本的 Codex 和 Claude Code 会自动获得本次任务的只读投研工具；其他运行时使用带日期的证据快照，设置页会说明限制。
讨论聊天中可查看公开工作摘要、工具结果、耗时和来源，无需编辑 MCP JSON 或增加连接步骤。

每个角色的研究过程放在对应会话中，可展开工具记录；研究中实时展示当前步骤，完成后收起。正文分为结论、依据、风险和后续观察，较长分析可以展开查看。

## 研究记忆

点击讨论页的书本图标查看这只股票的研究档案。先看当前论点与失效条件，再展开依据、已知时间、反证和版本历史。Agent 验收与你的个人确认分别记录；两者都不会把未知来源字段变成已核验事实。

后续研究按当前任务排列符合条件的记忆，在请求预算内发送完整论点。研究活动详情分别显示准备与实际发送的条目、版本和省略原因；发送记录不代表模型一定使用了这些内容。

报告在后台归档。档案会显示等待或失败的任务，支持重试和导入符合条件的历史报告，不额外调用模型。缺少结构化论点的旧报告保留为报告历史。关闭自动归档后，仍可明确选择手动导入或重试。

已启用的每日模拟策略可以监控价格、SMA20、RSI14 和日成交量比率，技术指标使用已完成的日线。未配置或不支持的条件会明确显示，数据缺失保持未知。条件一旦触发，就保留在该论点版本的历史中；触发后的新增风险需要验收后的替代判断或用户明确修订来建立新依赖，价格反弹不会抹掉原事件。

## 每日策略与自动模拟交易

在 **智能体搭建** 中启用研究团队和 **每日策略**，选择快速复核模型、配置通知，保存后激活。
团队在各市场开盘前制定策略。连续交易时段内，程序检查条件并计算技术指标；快速复核员可以同意、等待或否决。
模拟成交前，账本会再次校验当前策略、论点依赖、价格、资金、仓位和风控规则。保护性止损由确定性规则执行。
通知独立排队投递，重试通知不会重复下单。

升级后，缺少记忆依赖清单的旧策略需要生成新的有效策略，才能新增风险；保护性退出仍可执行。新策略中的结构化论点需要先完成归档。若已关闭自动归档，可在档案里手动导入或重试，无需重做研究。

已有智能体保留原模式，需要主动启用新功能。服务须持续运行；公开 Yahoo 行情可能延迟，技术指标使用已完成的日线，非分钟线。
内置美股、港股和 A 股交易日历覆盖 2026 年；日历不可用或数据无效时停止执行。
交易仅发生在模拟账户，不连接券商。API 研究遵守已配置的预算，本地 Agent 由其供应商计费。

## 接入你的 AI 助手

吵股内置 MCP 服务器。把模拟盘交给 Claude 或 ChatGPT：

1. 打开 **AI 模拟盘 → AI 代理 → 连接新代理**。
2. 把 MCP 地址和 Token 填入你 AI 助手的 MCP 设置。
3. 对它说"看看我的持仓"或"买入 NVDA 100 股"。

每个代理有独立的花费限额、只读/交易权限和审批模式。订单可以自动成交，也可以等你点一下批准。

## 隐私

自托管。零埋点。出网请求只有你自己用**自己的 API key** 发起的那几类。[完整说明 →](docs/privacy.zh-CN.md)

## 文档

| 主题 | 链接 |
|---|---|
| 本地部署与排错 | [docs/self-hosting.zh-CN.md](docs/self-hosting.zh-CN.md) |
| 七种研究 Agent 与成员模型设置 | [docs/local-agents.md](docs/local-agents.md) |
| 服务器部署（HTTPS） | [docs/public-deployment.zh-CN.md](docs/public-deployment.zh-CN.md) |
| 持仓导入 | [docs/import.md](docs/import.md) |
| 架构 | [docs/architecture.md](docs/architecture.md) |
| 开发指南 | [docs/development.md](docs/development.md) |
| 参与贡献 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| AI 开发技能 | [Squabble 开发与维护](.agents/skills/squabble-contributor/SKILL.md) |

---

吵股是「炒股」的谐音，但「吵」才是本意。牛牛和熊熊可以各执己见，最后拍板的人是你。

[MIT 开源](LICENSE) · 研究输出不构成投资建议。模拟盘结果不代表真实收益。
