# 浏览器采集：连接、采集与版本

2026-11-10。先在现有 V5 页完成可编辑稿，再实现前端。稿中的 Pickalphas、时间与版本数是交互示例，不表示已经登录或取得该网站正文。

## Figma 稿件

文件 `0dw4pcW4fkotFzqL7RxHLG`，V5 页 `160:998`；本轮 session `ed22a51b-9177-4f71-a5fe-46599b88371d`。保留旧稿 `165:1185`，在右侧增量扩展。

| 状态 | 可编辑节点 |
| --- | --- |
| 未连接 | [204:1092](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=204-1092) |
| 登录窗口已打开 | [204:1211](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=204-1211) |
| 已连接 | [204:1332](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=204-1332) |
| 登录过期，尚无版本 | [204:1453](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=204-1453) |
| 手机登录返回 | [204:1575](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=204-1575) |

桌面沿用原导航、订阅列表、798 宽详情，颜色绑定原有 `color/*` 变量；文字与容器均可编辑，未使用整屏截图作为设计层。Code Connect 无对应映射；已检索现有库，公共 Material/Simple 控件与本产品的现有控件样式不匹配，继续复用原 V5 自有结构。未新增第三方视觉组件。未连接与窗口打开的主按钮有原型状态连线。

已检查桌面和手机截图，修正自动高度与动作行裁切；过期状态延长至 1250 高以容纳恢复说明。归档：`D:/stock/ai-friend-v5-design/browser-login-open.png`、`D:/stock/ai-friend-v5-design/browser-mobile-login.png`、`D:/stock/ai-friend-v5-design/browser-needs-login.png`。实现依据读取详情 `204:1266` 和手机 `204:1575` 的 design context。

## 可观察行为

- 采集方式独立于认证方式：HTTP 用静态抓取和现有 HTTP 凭据；浏览器用隔离浏览器完成网站正常登录。浏览器当前只采集配置地址的动态页面正文，不承诺遍历整站。
- 先保存采集方式与设置，才可打开登录窗口或立即采集。表单有未保存变更时，两项操作均禁用并说明原因。
- 浏览器连接依次展示未连接、登录窗口已打开、已连接、登录过期；浏览器未安装、服务端无法交互等能力问题显示真实原因。用户在运行服务的电脑上登录，回到应用点击“我已登录，保存连接”。
- 保存连接与采集是不同操作。采集调用现有任务与版本接口，成功后显示新增版本或内容未变化，失败说明登录、超时、网络、空正文等原因。0 版本明确显示尚未保存内容。
- 断开连接必须单独确认；只清除服务端连接，不向浏览器前端导出 Cookie、密码或浏览器存储。
- 手机从列表进入详情，详情有“返回网站订阅”，返回保留列表位置与查询条件。界面沿用现有主题变量，支持浅色与深色。
- 浏览器采集版本预览标为“浏览器渲染正文”，展示该版本实际页面 URL、标题与采集时间。旧版本继续以自己的来源元信息展示，不用最新版本覆盖。

## 前端验证范围

使用虚构来源与 fake API 检查：保存前操作闸门、打开窗口/保存连接/采集顺序、过期与未安装反馈、0 版本文案、明确断开、手机返回、历史版本元信息。真实站点人工登录与真实内容结果需用户正常登录后单独验收。

已执行 `data-library-flow.test.cjs`（8 项通过）、前端 typecheck、相关 ESLint 与 CSS stylelint。以临时纯前端 fixture 在隔离 Vite 端口检查桌面、390px 手机浅色与深色：打开窗口、保存连接、单独采集、返回列表可操作；手机无横向溢出。截图在被 Git 忽略的 `output/playwright/browser-desktop-login.png`、`browser-mobile-login.png`、`browser-mobile-dark.png`。fixture 源文件和临时进程已清理；该验证没有启动后端或使用真实订阅。手机列表的滚动位置与焦点恢复也由 fake API 测试覆盖。
