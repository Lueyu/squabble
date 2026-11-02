# 本地研究 Agent / Local research agents

吵股可以直接使用电脑上的 **Codex** 和 **Claude Code**。设置页会显示是否安装、
是否登录，以及连接状态。首次登录仍由官方 CLI 在终端中完成；之后点击连接即可。
研究使用该 CLI 已有的账号与模型配置，可能产生服务商用量或费用。

## 桌面版

1. 打开 **设置 → 本地研究 Agent**。
2. 未安装时，点击安装链接并按官方说明完成安装：
   [Codex CLI](https://developers.openai.com/codex/cli/) 或
   [Claude Code](https://code.claude.com/docs/en/setup)。安装后刷新检测；必要时重启吵股。
3. 点击 **登录**，在打开的终端里完成服务商登录。回到设置，等待状态更新或点击刷新。
4. 显示已就绪后点击 **连接**。创建独立研究团队时，即可选择已连接的 Agent。

同一安装的本地研究运行环境只归属于一个吵股账号；其他本地账号不能直接使用它。
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
桌面助手主动连接网页服务，不会打开新的监听端口。桌面版与 Docker 的投资数据保持各自独立。

助手会自动重连。可在桌面 **帮助 → 本地 Agent 助手** 中查看连接地址和状态。
在网页设置中断开助手会撤销配对凭证；桌面助手收到撤销后会停止任务并清除保存的配对。
退出桌面应用、取消研究、断开配对，或连续失联超过 30 秒，都会停止相关任务。
中断的任务不会自动重跑；确认原因后可以发起新的研究。

## 研究、费用与数据

- 每个连接对每个服务商最多运行一个任务。桌面版和已配对的 Docker 网页是独立连接。
- Codex 使用只读研究环境与原生搜索；Claude Code 使用受限的研究工具。
  本地运行不代表离线推理，研究内容仍会发送给所选服务商。
- CLI 用量由服务商账号管理。吵股无法确认的用量显示为未知。连接 CLI 不会改变全局预算；
  使用模型 API 的团队成员继续受原有预算约束。
- 报告中的观点和来源仍需核查，模拟交易风控和审批保持生效。
- 桌面配对凭证保存在系统的吵股应用数据目录中。Docker 的配对和任务状态保存在
  `local-agents-data` 卷中；更新应用时应保留此卷。

旧版外部 Agent 连接需要在设置中重新连接 Codex 或 Claude Code。已有报告仍可查看。

## English

Squabble connects directly to **Codex** and **Claude Code** installed on your computer.
Open **Settings → Local research agents**, follow the official installation link if
needed, then choose **Sign in**. Complete the provider's native sign-in in the terminal,
return to Settings, and select **Connect** when the agent is ready. Connected agents
are available for independent research teams. Model API execution remains available.

For Docker, install and open the [Squabble desktop app](https://github.com/Lueyu/squabble/releases/latest)
on the same computer. Create a pairing request in web Settings and open the desktop
companion. Confirm the displayed local web origin in the native desktop dialog, then
return to web Settings to sign in and connect your agents. No account IDs, endpoint
configuration, tokens, registry files or extra listening ports are needed. Pairing
links expire and work once; create a fresh request if one expires.

Only `localhost`, `127.0.0.1` and `[::1]` HTTP(S) origins are supported. Keep the desktop
app open. **Help → Local Agent Companion** shows its connection status. Disconnecting
in web Settings revokes the saved pairing. The helper reconnects automatically, but
cancelled tasks, revoked pairings, shutdown and network loss beyond 30 seconds stop
active work. Interrupted tasks are never automatically rerun.

Each connection allows one active task per provider. The desktop's own workspace and
a paired Docker workspace are separate connections and keep separate portfolio data.
Native CLIs use their own accounts and model configuration; charges or subscription
limits are managed by the provider. Unknown token usage remains unknown. Connecting a
CLI does not change the global budget, and API model members retain their existing
budget controls. Local execution still sends research content to the selected provider.
Reports require independent verification and existing paper-trading controls remain.

The desktop stores its pairing privately in its application data directory. Docker
persists pairing and task state in the `local-agents-data` volume; preserve it during
updates. A native runtime belongs to one Squabble account on that installation. Older
external agent connections need to be reconnected as Codex or Claude Code; historical
reports remain readable.
