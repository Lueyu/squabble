# Browser source collection

Website subscriptions offer HTTP and browser capture modes. HTTP remains the
default for existing sources. Browser mode renders the configured page in an
isolated Chromium context and saves its main text as a versioned research source.
It captures that page, not an automatically discovered archive of an entire site.

## Connect and collect

1. Open Data → Website subscriptions, choose a source, select Browser and save.
2. On the computer running the local Squabble service, choose **Open browser and
   sign in**. Complete the website's normal login in the dedicated window.
3. Return to Squabble and choose **I have signed in, save connection**. This
   explicit action saves encrypted session state on the server.
4. Choose **Collect now**. Read the recorded job result, then open the exact saved
   version in Library or Research. Scheduled collection uses the same path while
   the service is running. Expired login stops automatic retries until reconnected.

Saving a connection and collecting content are separate actions. A successful
connection does not prove a subscription article has been acquired. Rendered
versions identify their capture method, actual page URL/title and observation
time. Empty/login pages fail rather than creating a successful source version.
HTTP Basic is not a substitute for a normal email/password website form.

Browser login windows are restricted to the local workspace and loopback caller;
they open on the server computer, not a remote phone. Installations without a
browser or an interactive desktop show their actual unavailable capability.
The default Alpine application image does not include Chromium. Installing this
feature's JavaScript dependency alone does not install a browser or provide a
remote-login screen. No remote desktop/browser endpoint or global MCP access is
enabled by this feature.

For source installations, run `npx playwright install chromium` from the release
root, or use the supported installed Chrome detected by the runtime. Interactive
login requires a normal local graphical session. Chromium must be able to run its
sandbox; TLS errors are not ignored. A configured upstream HTTP(S) proxy is used
internally. Unsupported proxy configuration is reported explicitly.

## Agent access and provenance

Task-scoped research Agents receive `read_browser_source({ sourceId })`. The tool
can collect only an enabled, owned, saved browser source; it cannot accept a URL,
profile path, password, cookies or browser endpoint. It returns bounded excerpts
and exact source/version references. Activity is recorded as a real browser-source
tool call. Existing source exclusion/deletion rules apply to reports and memory.

The collector uses a short-lived authenticated public-network egress proxy with
verified-address connections, bounded browser lifetime/requests/bytes, and browser
context isolation. Login and collection use separate lifetimes. Sync commits must
match the source revision, current job and unexpired lease token. Cancellation,
source edits and disconnection stop active work and prevent late results.

Browser state may contain cookies and local storage. It is encrypted separately
from HTTP credentials using the instance's existing settings key. It is not
returned by source/status APIs, sent to models or stored as article content.
Disconnecting removes the current stored state; historical backups retain their
matched encrypted data. Preserve the database and settings key together.

OAuth login may temporarily visit another public site, but confirmation and
collection must end at the configured origin. Only source-applicable cookies and
that origin's local storage are saved/restored. Third-party sign-in state is
discarded. Same-origin path redirects are supported. Rendered content and its URL
are captured together; a later cross-origin navigation invalidates the capture.

## 中文操作

在“数据中心 → 网站订阅”选择“浏览器动态采集”，先保存，再打开专用浏览器。
手工完成网站登录后回到 Squabble 点“我已登录，保存连接”，然后单独点“立即采集”。
登录过期会显示需要重连；服务器缺少浏览器或无法显示窗口会说明原因。它采集当前
配置地址的动态正文；站内其他页面可以另建来源。研究 Agent 使用专用工具调用同一
条采集与版本流程，不获得任意浏览器操作或登录凭据。

验证命令：先安装 Chromium，再运行 `npm run test:browser`。数据生命周期与工具
集成测试还需要按开发指南配置真正独立的 PostgreSQL 测试库。不要以个人账户、真实
订阅凭据或付费模型调用作为自动化测试数据。
