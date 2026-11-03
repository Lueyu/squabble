English | [简体中文](README.zh-CN.md)

<div align="center">

<img src="client/public/logo.svg" width="88" alt="Squabble logo" />

# Squabble

**Let your AI argue. You decide.**

An open-source investing workspace.
A bull, a bear and a critic challenge your ideas.
Then you make the call.

**US · HK · China A-shares** · **English / Chinese** · **Self-hosted** · **Zero telemetry**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Lueyu/squabble/actions/workflows/ci.yml/badge.svg)](https://github.com/Lueyu/squabble/actions/workflows/ci.yml)
[![Desktop](https://img.shields.io/badge/Desktop-Windows%20%7C%20macOS-blue)](https://github.com/Lueyu/squabble/releases/latest)

</div>

![Squabble dashboard](docs/screenshots/dashboard-en.png)

## Why Squabble?

Most portfolio trackers show numbers. Squabble argues about them.

- **AI research reports.** A bull and a bear debate your holdings. A critic removes weak arguments. Your risk rules run as hard gates. The result is a 14-section report with both sides preserved.
- **AI paper trading.** A virtual account. Your AI watches markets, trades on your research signals, and sends you a push notification on every fill. Connect Claude or ChatGPT through MCP. Set per-agent spending limits and approval modes.
- **Your data stays yours.** Self-hosted. Zero telemetry. Only a username and password — no phone number, no email verification.

## Install

### Desktop app (Windows / macOS)

1. Go to the [Releases page](https://github.com/Lueyu/squabble/releases/latest).
2. Download the installer for your system (`.exe` for Windows, `.dmg` for macOS).
3. Run the installer. Everything is bundled — PostgreSQL, the server, and the app.

After install, Squabble opens in its own window. Your data stays on your machine.

### Web app (Docker)

You need [Git](https://git-scm.com/downloads) and [Docker Desktop](https://docs.docker.com/get-docker/).

```bash
git clone https://github.com/Lueyu/squabble.git
cd squabble
docker compose up -d
```

Open **http://localhost:3000**. Create your first account.

The database starts empty. To try a demo with fictional data, run `docker compose -f docker-compose.demo.yml up -d --build` instead.

### From source (developers)

You need Node.js 22+ and npm 10+.

```bash
git clone https://github.com/Lueyu/squabble.git && cd squabble
npm install
npm run dev
```

## What it does

| Feature | Description |
|---|---|
| **Portfolio tracking** | US/HK/CN holdings, cash, P&L and net-value curves. USD/HKD/CNY conversion built in. |
| **AI research** | Bull-bear debate, critic review, risk gates. 14-section report. Versioned, with losing arguments kept. |
| **Paper trading** | AI bot with hard risk limits (daily-loss breaker, per-order cap). Manual and MCP agent orders. |
| **Portfolio import** | CSV with auto column mapping (5 broker presets). Screenshot OCR via your own AI key. |
| **Notifications** | Webhook, Bark, ServerChan, SMTP, Telegram. Every fill and risk event, pushed to you. |

## Connect native research agents

Open **Settings → Local research agents** to use Codex, Claude Code, Gemini CLI,
Antigravity, OpenCode, Kimi or the community Doubao CLI already
installed on your computer. Sign in through the provider's terminal, then click
**Connect**. For Docker, open Squabble desktop on the same computer and pair it
from web Settings; confirm the local address in the desktop dialog. Keep the app
open while researching. Each member can select a model and the reasoning options
supported by its agent, or inherit the existing defaults. [Setup and usage details](docs/local-agents.md).

Compatible Codex and Claude Code versions automatically receive task-scoped,
read-only research tools; other runtimes receive a dated evidence snapshot with
the limitation shown in Settings. The discussion chat shows public work summaries,
tool outcomes, elapsed time and sources. No MCP JSON or extra connection steps are needed.

## Connect your AI assistant

Squabble has a built-in MCP server. Give Claude or ChatGPT access to your paper account:

1. Open **AI Paper Trading → AI Agents → Connect Agent**.
2. Copy the MCP URL and token into your assistant's MCP settings.
3. Ask it to *"check my portfolio"* or *"buy 100 shares of NVDA"*.

Each agent gets a spending limit, a read-only or trade permission, and an approval mode. Orders can auto-fill, or wait for your tap.

## Privacy

Self-hosted. Zero telemetry. The only outbound requests are the ones you make with your own API keys. [Full details →](docs/privacy.md)

## Docs

| Topic | Link |
|---|---|
| Local setup and troubleshooting | [docs/self-hosting.md](docs/self-hosting.md) |
| Seven research agents and per-member model settings | [docs/local-agents.md](docs/local-agents.md) |
| Server deployment (HTTPS) | [docs/public-deployment.md](docs/public-deployment.md) |
| Import your portfolio | [docs/import.md](docs/import.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Development guide | [docs/development.md](docs/development.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

---

*Squabble* comes from the Chinese word for trading stocks (*chao gu*), but with *chao* meaning "argue." The bull and bear have opinions. You make the call.

[MIT](LICENSE) · Research outputs are not investment advice. Paper results do not predict real returns.
