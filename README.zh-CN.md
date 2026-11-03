[English](README.md) | 简体中文

<div align="center">

<img src="client/public/logo.svg" width="88" alt="吵股" />

# 吵股 · Squabble

**让 AI 替你吵，你来定。**

开源投资工作台。
多头、空头和批评者审视你的想法。
最后由你拍板。

**美股 · 港股 · A 股** · **中英双语** · **自托管** · **零埋点**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Lueyu/squabble/actions/workflows/ci.yml/badge.svg)](https://github.com/Lueyu/squabble/actions/workflows/ci.yml)
[![桌面版](https://img.shields.io/badge/Desktop-Windows%20%7C%20macOS-blue)](https://github.com/Lueyu/squabble/releases/latest)

</div>

![吵股仪表盘](docs/screenshots/dashboard.png)

## 为什么试试吵股？

大多数持仓工具只展示数字。吵股会为你的数字吵架。

- **AI 研报。** 多头和空头围绕你的持仓辩论。批评者推翻站不住脚的论点。你的风控规则作为硬门把关。输出 14 节研究报告，正反双方论点完整保留。
- **AI 模拟炒股。** 独立虚拟账户。AI 全天候盯盘，按你的研究信号下单，成交即推送。通过 MCP 接入 Claude 或 ChatGPT。每个代理有独立花费限额和审批模式。
- **数据只属于你。** 自托管。零埋点。只要用户名和密码——不收手机号、不收邮箱验证。

## 安装

### 桌面版（Windows / macOS）

1. 打开 [Releases 页面](https://github.com/Lueyu/squabble/releases/latest)。
2. 下载对应系统的安装包（Windows 下 `.exe`，macOS 下 `.dmg`）。
3. 双击安装。内置 PostgreSQL 和全部服务，无需另装任何软件。

安装后吵股会在独立窗口打开。数据保存在你的电脑上。

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

## 它能干什么

| 功能 | 说明 |
|---|---|
| **持仓管理** | 美/港/A 股持仓、现金、盈亏与净值曲线。内置 USD/HKD/CNY 折算。 |
| **AI 研报** | 多空辩论、批评者审视、风控硬门。14 节报告。版本化保留，输掉的论点原文保存。 |
| **模拟炒股** | AI 盯盘 + 硬性风控（日亏损熔断、单笔上限）。支持手动下单和 MCP 代理下单。 |
| **持仓导入** | CSV 自动列映射（5 券商预设）。截图 OCR 识别（用你自己的 AI key）。 |
| **通知推送** | Webhook、Bark、Server酱、邮件、Telegram。每笔成交和风控事件即推。 |

## 连接本地研究 Agent

打开 **设置 → 本地研究 Agent**，即可使用电脑上已安装的 Codex、Claude Code、Gemini CLI、Antigravity、OpenCode、Kimi 或社区豆包 CLI。
在对应终端完成登录后，点击 **连接**。Docker 用户在同一台电脑打开吵股桌面版，
从网页设置发起配对，再在桌面弹窗中确认本地地址。研究期间保持桌面应用开启。
每位成员可选择模型和 Agent 支持的推理选项，也可以沿用原有默认配置。[安装与使用说明](docs/local-agents.md)。

兼容版本的 Codex 和 Claude Code 会自动获得本次任务的只读投研工具；其他运行时使用带日期的证据快照，设置页会说明限制。
讨论聊天中可查看公开工作摘要、工具结果、耗时和来源，无需编辑 MCP JSON 或增加连接步骤。

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
| 持仓导入 | [docs/zh-CN/import.md](docs/zh-CN/import.md) |
| 架构 | [docs/architecture.md](docs/architecture.md) |
| 开发指南 | [docs/development.md](docs/development.md) |
| 参与贡献 | [CONTRIBUTING.md](CONTRIBUTING.md) |

---

吵股是「炒股」的谐音，但「吵」才是本意。牛牛和熊熊可以各执己见，最后拍板的人是你。

[MIT 开源](LICENSE) · 研究输出不构成投资建议。模拟盘结果不代表真实收益。
