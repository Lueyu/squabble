# 本地研究 Agent / Local research agents

吵股支持 **Codex、Claude Code、Gemini CLI、Antigravity、OpenCode、Kimi** 和社区 **Doubao CLI**。设置页会显示安装、登录和连接状态。首次登录在对应 CLI 终端完成，之后点击连接即可。研究使用该 CLI 的账号，可能产生服务商用量或费用。

OpenCode 默认模型若省略供应商前缀，吵股会在已公布的模型列表中查找唯一匹配项，将完整的 `provider/model` 固定到本次新任务并传给 CLI。存在多个匹配项时，需要在设置中明确选择。应用不会改写 CLI 配置或已保存任务；失败的日报仍由用户在原研究中继续。

If an OpenCode default omits its provider prefix, Squabble resolves a unique match from the advertised model list and passes the full `provider/model` identity to the CLI for that new task. Ambiguous matches require an explicit selection in Settings. CLI preferences and saved tasks remain unchanged; continuing a failed daily report remains an explicit user action.

## 持仓截图导入 / Portfolio screenshot import

持仓导入的截图页优先选择已连接、空闲且支持图片附件的 Agent，当前为 Codex 和 OpenCode。
可选择模型；模型本身须支持视觉输入。其他 Agent 或旧版桌面助手未声明图片能力时，页面提供视觉 API 选项。
上传 PNG、JPEG 或 WebP（最大 8MiB），开始识别后可查看状态、取消任务；返回的持仓需核对、编辑并确认才会写入。
用量耗尽、限流、登录失效和超时分别提示；不会自动切换供应商或重复调用。任务结果在 20 分钟后或服务器重启后失效。

The screenshot importer prefers a connected, idle image-capable agent: currently Codex or OpenCode.
Choose a vision-capable model, or switch explicitly to a vision API. PNG, JPEG and WebP up to 8MiB are supported.
Recognition runs as a cancellable background job; review and edit the rows before confirming import.
Usage limits, rate limits, expired login and timeouts have distinct messages, with no automatic provider fallback or retry.
Job results expire after 20 minutes or a server restart. Local-agent execution may use the provider's cloud and billing.

## 每位成员的模型与推理设置

打开投研讨论室的成员编辑面板，选择本地 Agent 后可选择模型及其支持的推理选项。
默认“沿用 Agent 默认设置”；模型目录可用时直接选择，也可填写供应商的准确模型标识。
不同模型支持的推理档位可能不同，只支持思考开关的模型不会显示虚构的高低档位。
旧版桌面助手不支持传递这些设置时，需要更新助手；系统不会悄悄忽略你的选择。

设置随团队及研究快照保存，只影响新建研究任务，不会修改个人 CLI 的全局配置。
切换 Agent 会清空原来的模型/推理覆盖；切换模型会清除不兼容的推理选项。
模型 API 执行方式的“快速／深度模型”仍属于独立配置。

| Agent | 模型与推理选项 |
| --- | --- |
| Codex | 读取本机模型目录与支持的推理档位；也可填写模型 ID。 |
| Claude Code | 支持原生模型名称或别名；推理档位由模型和 CLI 版本决定。 |
| Gemini CLI | 支持具体模型或原生默认路由；已确认支持的具体模型可选择思考强度。 |
| Antigravity | 需要原生 `agy` 1.3.4 或更新版本，读取其模型目录并传递推理选项。 |
| OpenCode | 读取已配置提供方的模型及其 reasoning variants。 |
| Kimi Code | 使用当前 `@moonshot-ai/kimi-code`；读取本机模型及其 `support_efforts`。 |
| Doubao Agent | 读取社区 CLI 的实时模型目录，按上游名称和推理参数创建云端任务。 |

Antigravity 研究使用独立临时设置，同时保留原生系统钥匙串或 API/ADC 登录。
若安装仅使用与原配置目录绑定的登录文件，研究前的鉴权检查可能无法复用该登录；
需要先完成原生系统钥匙串登录。系统不会改写用户全局设置来绕过这个限制。

豆包使用 [社区 doubao-cli](https://github.com/Fullstop000/doubao-cli) 的 headless Agent 会话。
它不是官方 CLI；登录需要在终端按提示扫码。模型使用目录中的准确名称。
Windows 已验证隔离环境的启动、能力查询和未登录检测，真实账号研究兼容性尚未验证。
更多实现依据见 [Clowder Agent、Skills 与 MCP 核对](clowder-agent-and-tool-research.md)。

## 自动投研工具与聊天进度

连接后无需额外配置。Codex 0.104.0+、Claude Code 2.1.221+ 在通过运行时检查后，
可在任务中读取行情、财务、估值、新闻、当前工作区的历史报告和本讨论上下文。
启用网络研究时，还可使用现有预算约束下的网页检索。工具不会授予交易或持仓写入权限。

其他五种运行时，以及低于上述版本或版本无法识别的 Codex/Claude，使用带时间的只读证据快照。
设置页和成员编辑页会显示“投研工具”或“证据快照”及原因；快照不会显示成实时工具调用。
该矩阵表示吵股已验证的接入能力，不表示其他 CLI 本身不支持 MCP。

聊天中的“研究过程”会显示角色任务、公开工作摘要、具体工具动作、耗时、来源和失败/取消状态。
刷新后可恢复已保存的过程；旧轮次单独折叠，最终回复可从任务卡跳转。
助手没有报告的结果不会推断为成功，未知用量仍显示未知。过程不包含私有思维链、登录凭证或原始进程日志。
研究工具只在任务临时配置中生效，不改写个人 CLI 配置；本机 MCP 端口仅在任务期间开启。

## 桌面版

1. 打开 **设置 → 本地研究 Agent**。
2. 未安装时，点击对应 Agent 的安装链接，按该项目的说明完成安装。
   Antigravity 需要原生 `agy` 1.3.4 或更新版本，Kimi 需要当前的 `@moonshot-ai/kimi-code`。
   安装后刷新检测；必要时重启吵股。
3. 点击 **登录**，在打开的终端里完成服务商登录。回到设置，等待状态更新或点击刷新。
4. 显示已就绪后点击 **连接**。创建独立研究团队时，即可选择已连接的 Agent。

桌面版和源码的 `AUTH_MODE=local` 工作区无需吵股登录，原生 Agent 连接属于这台安装实例，
不再受旧吵股账号归属限制。服务商 CLI 的登录、凭证和费用保持独立。
显式使用 `AUTH_MODE=account` 时，仍保留原来的账号隔离和运行环境归属。
使用期间需要保持桌面应用开启。模型 API 的执行方式仍然可用。

## Docker 网页版

Docker 使用同一台电脑上的吵股桌面应用作为助手：

1. 安装并打开 [吵股桌面版](https://github.com/Lueyu/squabble/releases/latest)。
2. 在 Docker 网页的 **设置 → 本地研究 Agent** 中创建配对请求，打开桌面助手。
3. 浏览器询问是否打开 Squabble 时选择打开。桌面应用会显示网页地址，例如
   `http://localhost:3000`。确认地址与刚才使用的本地网页一致，再点击连接。
4. 返回网页设置，按上面的安装、登录、连接步骤操作。

不需要填写账号 ID、服务地址、注册表、Token 或额外端口。配对链接会过期且只能使用一次；
失败时在设置中重新创建即可。仅支持本机 `localhost`、`127.0.0.1` 或 `[::1]` 的网页地址。
桌面助手主动连接网页服务；兼容的原生 CLI 会使用任务期间的本机临时 MCP 端口，
无需手动映射或开放端口。桌面版与 Docker 的投资数据保持各自独立。

助手会自动重连。可在桌面 **帮助 → 本地 Agent 助手** 中查看连接地址和状态。
在网页设置中断开助手会撤销配对凭证；桌面助手收到撤销后会停止任务并清除保存的配对。
退出桌面应用、取消研究、断开配对，或连续失联超过 30 秒，都会请求停止相关任务。
豆包等云端任务需要上游确认停止；状态不明确时会保留任务标识并提示待确认。
中断的任务不会自动重跑，避免重复提交；确认已有任务已结束后再发起新的研究。

## 研究、费用与数据

- 每个连接对每个服务商最多运行一个任务。桌面版和已配对的 Docker 网页是独立连接。
- Codex 使用只读研究环境与原生搜索；Claude Code 使用受限的研究工具。
  本地运行不代表离线推理，研究内容仍会发送给所选服务商。
- CLI 用量由服务商账号管理。吵股无法确认的用量显示为未知。连接 CLI 不会改变全局预算；
  使用模型 API 的团队成员继续受原有预算约束。
- 当 CLI 明确报告额度耗尽、余额不足或请求限流时，讨论会暂停，并在角色研究记录与聊天提示中说明原因。
  OpenCode 的主研究流错误也会从调用日志中识别，避免已报额度错误却一直等待到超时。
  请查看供应商账户的额度与重置时间，或调整角色模型；限流时可稍后再新建讨论。
  系统不会自动重试或切换付费模型。原始日志、密钥及私人推理不会显示。
  Docker 网页使用者应同时更新服务端和桌面助手，才能看到完整的分类提示；旧服务端仍可接收失败状态。
- 报告中的观点和来源仍需核查，模拟交易风控和审批保持生效。
- 桌面配对凭证保存在系统的吵股应用数据目录中。Docker 的配对和任务状态保存在
  `local-agents-data` 卷中；更新应用时应保留此卷。

旧版外部 Agent 连接需要在设置中重新连接受支持的 Agent。已有报告仍可查看。

## English

Compatible Codex 0.104.0+ and Claude Code 2.1.221+ automatically receive task-scoped,
read-only tools for quotes, financials, valuation, news, saved workspace reports and
discussion context. Web research is available only when enabled and retains the
existing request budgets. No trade or portfolio-write permission is granted.
Other runtimes, and older or unrecognized Codex/Claude versions, receive a dated
evidence snapshot. Settings and the member editor show the mode and its reason.
This describes verified Squabble integration, not the CLIs' general MCP support.

Discussion chat shows public work summaries, tool outcomes, sources, elapsed time,
and failure/cancellation states. Saved events survive refresh; previous revisions
are separated and task cards link to final replies. Missing outcomes never imply
success. Private reasoning, credentials and raw process logs are not displayed.
Task configuration does not modify global CLI settings. Compatible runtimes use a
temporary loopback MCP listener; no manual port mapping or configuration is needed.

Squabble connects to **Codex, Claude Code, Gemini CLI, Antigravity, OpenCode, Kimi**
and the community **Doubao CLI** installed on your computer.
Open **Settings → Local research agents**, follow the linked installation guide if
needed, then choose **Sign in**. Complete the CLI sign-in in the terminal,
return to Settings, and select **Connect** when the agent is ready. Connected agents
are available for independent research teams. Model API execution remains available.

In the member editor, choose a model and the reasoning options advertised by that
agent/model, or inherit the CLI defaults. Manual model identifiers are supported;
Doubao expects the exact catalog name. Choices are saved with the member and task,
never written to global CLI configuration. Switch providers to reset overrides;
switch models to clear incompatible effort. Older companions must be updated before
using overrides. Unsupported reasoning levels are not simulated.

Antigravity requires native `agy` 1.3.4 or later. Research uses temporary settings
and reuses OS keyring or API/ADC authentication; credentials stored only in a
profile-bound file may require native keyring sign-in before the preflight succeeds.
Kimi requires the current `@moonshot-ai/kimi-code` CLI. Gemini reasoning overrides
require an explicitly supported model; automatic routing inherits native defaults.

Doubao uses the community [doubao-cli](https://github.com/Fullstop000/doubao-cli)
headless Agent bridge, not an official CLI. Windows startup, capability discovery and
signed-out status have been checked in isolation; signed-in research remains unverified.

For Docker, install and open the [Squabble desktop app](https://github.com/Lueyu/squabble/releases/latest)
on the same computer. Create a pairing request in web Settings and open the desktop
companion. Confirm the displayed local web origin in the native desktop dialog, then
return to web Settings to sign in and connect your agents. No account IDs, endpoint
configuration, tokens, registry files or extra listening ports are needed. Pairing
links expire and work once; create a fresh request if one expires.

Only `localhost`, `127.0.0.1` and `[::1]` HTTP(S) origins are supported. Keep the desktop
app open. **Help → Local Agent Companion** shows its connection status. Disconnecting
in web Settings revokes the saved pairing. The helper reconnects automatically, but
cancelled tasks, revoked pairings, shutdown and network loss beyond 30 seconds request
cancellation. Cloud tasks require upstream confirmation; uncertain tasks retain their
identifiers and show a pending-confirmation error. Interrupted tasks are never automatically rerun.

Each connection allows one active task per provider. The desktop's own workspace and
a paired Docker workspace are separate connections and keep separate portfolio data.
Native CLIs use their own accounts and model configuration; charges or subscription
limits are managed by the provider. Unknown token usage remains unknown. Connecting a
CLI does not change the global budget, and API model members retain their existing
budget controls. Local execution still sends research content to the selected provider.
Reports require independent verification and existing paper-trading controls remain.

When the CLI explicitly reports exhausted usage, insufficient balance or rate limiting,
the discussion pauses with an actionable message in the member's research history and
chat. OpenCode primary-stream diagnostics are also checked so a reported quota failure
does not wait for the research timeout. Check the provider account for usage/reset time,
or change the member's model; try a new discussion later for rate limits. Tasks are not
automatically retried and paid models are not selected automatically. Raw diagnostics,
credentials and private reasoning are never displayed. Unknown failures keep a generic
error; remaining provider quota and reset times are not estimated by Squabble.
For Docker web use, update both the server and desktop companion for full categorized
messages. Older servers can still acknowledge the failed task without losing heartbeats.

The desktop stores its pairing privately in its application data directory. Docker
persists pairing and task state in the `local-agents-data` volume; preserve it during
updates. In desktop/source `AUTH_MODE=local` workspaces, native connections belong to
the installation without a Squabble login or legacy account-owner restriction.
Provider CLI sign-in and billing remain separate. `AUTH_MODE=account` keeps the
existing account isolation and native runtime ownership. Older
external agent connections need to be reconnected as supported native agents; historical
reports remain readable.
