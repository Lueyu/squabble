/**
 * main.mts — Electron 主进程入口（打包后由 package.json "main" 指向 dist/desktop/main.mjs 启动）。
 *
 * 职责边界：
 *  - 应用生命周期：单实例锁、squabble:// 协议配对链接分发、应用菜单、更新检查（自动/手动两条路径）。
 *  - 拉起本地三件套：本地 Agent 伴侣（companion.mts）、内嵌 PostgreSQL 与后端 server（runtime.mts）；
 *    后端以 utilityProcess 子进程运行 dist/server/main.js，输出写入数据目录 logs/backend.log。
 *  - 创建主窗口加载回环 SPA，并做外部链接/导航护栏（仅放行本站 origin）。
 * 上下游：
 *  - 上游（谁启动）：Electron 运行时（npm run desktop:dev / 打包安装器）；烟测经 SQUABBLE_DESKTOP_SMOKE=1 驱动。
 *  - 下游（启动谁/连接什么）：companion.mts 的 LocalAgentCompanion、runtime.mts 的内嵌 PostgreSQL、
 *    utilityProcess 里的 NestJS 后端；主窗口加载 http://127.0.0.1:<port>。
 * 关键约定：
 *  - 进程模型：本文件仅运行在 Electron 主进程；companion 的 HTTP 轮询也在主进程；后端 NestJS 是独立子进程。
 *  - 渲染进程不开 preload API（contextIsolation + sandbox + nodeIntegration=false），页面只经回环 HTTP 访问后端。
 *  - 配对协议：squabble:// 链接（open-url 或命令行参数）先进 pendingPairLinks 队列（最多 3 条），
 *    配对确认弹窗由用户手动放行。
 *  - 烟测模式：SQUABBLE_DESKTOP_SMOKE=1 + SQUABBLE_DESKTOP_DATA_DIR（必须绝对路径）；各阶段经
 *    markSmokeStage 写 packaged-smoke-stage.log，成功后写 packaged-smoke.json 并退出。
 */
import { appendFileSync, createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, Menu, session, shell, utilityProcess } from 'electron';
import type { MenuItemConstructorOptions, UtilityProcess } from 'electron';
import {
  desktopPaths,
  loadOrCreateSecrets,
  loadOrCreateServerPort,
  nestEnvironment,
  startDesktopDatabase,
  waitForHealth,
} from './runtime.mjs';
import type { DesktopDatabase } from './runtime.mjs';
import { checkForUpdate, isNewerVersion } from './update-check.mjs';
import { isAutomaticUpdateSupported } from './auto-update.mjs';
import { LocalAgentCompanion, parsePairingLink } from './companion.mjs';
import type { NativeRuntime } from './companion.mjs';

let window: BrowserWindow | null = null;
let backend: UtilityProcess | null = null;
let database: DesktopDatabase | null = null;
let backendLog: ReturnType<typeof createWriteStream> | null = null;
let quitting = false;
let stoppingServices: Promise<void> | null = null;
let quitAllowed = false;
let checkingForUpdate = false;
let companion: LocalAgentCompanion | null = null;
const pendingPairLinks: string[] = [];
let handlingPairLink = false;

function queuePairingLink(link: string): void {
  if (!parsePairingLink(link) || pendingPairLinks.includes(link) || pendingPairLinks.length >= 3)
    return;
  pendingPairLinks.push(link);
  if (app.isReady()) void handlePendingPairings();
}

async function handlePendingPairings(): Promise<void> {
  if (!companion || handlingPairLink || quitting) return;
  handlingPairLink = true;
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  try {
    while (pendingPairLinks.length && !quitting) {
      const link = pendingPairLinks.shift();
      if (!link) continue;
      try {
        const paired = await companion.pair(link, async (origin) => {
          const choice = await dialog.showMessageBox({
            type: 'question',
            title: 'Squabble',
            message: chinese
              ? '允许此本地应用使用你的研究 Agent？'
              : 'Allow this local app to use your research agents?',
            detail: chinese
              ? `${origin}\n\n连接后，此应用可以使用你的 CLI 登录账号运行 Codex 和 Claude Code 研究任务，可能消耗套餐用量或产生费用。请确认这正是你刚刚在设置中打开的地址。`
              : `${origin}\n\nThis app can run Codex and Claude Code research tasks using your CLI sign-in, which may consume your plan or incur charges. Confirm this is the address you just opened in Settings.`,
            buttons: chinese ? ['连接', '取消'] : ['Connect', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
          });
          return choice.response === 0;
        });
        if (paired)
          await dialog.showMessageBox({
            type: 'info',
            title: 'Squabble',
            message: chinese ? '桌面助手已配对' : 'Desktop companion paired',
            detail: chinese
              ? '返回网页设置，登录并连接 Codex 或 Claude Code。使用期间请保持桌面应用开启。'
              : 'Return to web Settings to sign in and connect Codex or Claude Code. Keep the desktop app open while using them.',
          });
      } catch {
        await dialog.showMessageBox({
          type: 'warning',
          title: 'Squabble',
          message: chinese ? '无法配对桌面助手' : 'Could not pair the desktop companion',
          detail: chinese
            ? '确认本地应用正在运行，然后在网页设置中创建新的配对请求。'
            : 'Make sure the local app is running, then create a new pairing request in web Settings.',
        });
      }
    }
  } finally {
    handlingPairLink = false;
  }
}

async function showCompanionStatus(): Promise<void> {
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  const status = companion?.status;
  const states = chinese
    ? {
        unpaired: '尚未配对',
        connecting: '正在连接',
        connected: '已连接',
        offline: '暂时离线，正在重连',
      }
    : {
        unpaired: 'Not paired',
        connecting: 'Connecting',
        connected: 'Connected',
        offline: 'Offline; reconnecting',
      };
  const providerStates = chinese
    ? { not_installed: '未安装', login_required: '需要登录', ready: '已就绪', error: '检测失败' }
    : {
        not_installed: 'Not installed',
        login_required: 'Sign-in required',
        ready: 'Ready',
        error: 'Detection failed',
      };
  const details = status
    ? [
        states[status.state],
        status.origin ?? '',
        ...status.agents.map((agent) => `${agent.name}: ${providerStates[agent.state]}`),
        chinese ? `正在运行的任务：${status.activeTasks}` : `Running tasks: ${status.activeTasks}`,
        chinese
          ? '在 Docker 网页的设置中配对或断开助手。使用期间请保持此应用开启。'
          : 'Pair or disconnect the companion in Docker web Settings. Keep this app open while using it.',
      ]
    : [
        chinese
          ? '桌面助手不可用，请重启应用后重试。'
          : 'The desktop companion is unavailable. Restart the app to retry.',
      ];
  await dialog.showMessageBox({
    type: 'info',
    title: 'Squabble',
    message: chinese ? '本地研究 Agent 助手' : 'Local research agent companion',
    detail: details.filter(Boolean).join('\n\n'),
  });
}

async function startCompanion(dataRoot: string): Promise<void> {
  try {
    const runtime = createRequire(import.meta.url)(
      join(app.getAppPath(), 'dist', 'server', 'local-agents', 'native.js'),
    ) as NativeRuntime;
    companion = new LocalAgentCompanion({
      dataDir: join(dataRoot, 'local-agent-companion'),
      name: hostname(),
      native: runtime,
    });
    await companion.restore();
    companion.start();
    void handlePendingPairings();
  } catch {
    companion = null;
    // 配对存储与 CLI 诊断信息可能包含凭据，任何情况下都不展示原始错误。
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Squabble',
      message: app.getLocale().toLowerCase().startsWith('zh')
        ? '桌面助手无法启动，请重启应用后重试。'
        : 'The desktop companion could not start. Restart the app to retry.',
    });
  }
}

async function showWindowsUpdateCheck(chinese: boolean, silent: boolean): Promise<void> {
  // 急切加载 electron-updater 会拖慢打包后的启动，必须等 app 就绪后再动态 import。
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const result = await autoUpdater.checkForUpdates();
  const version = result?.updateInfo.version;
  if (!version || !isNewerVersion(version, app.getVersion())) {
    if (!silent)
      await dialog.showMessageBox({
        type: 'info',
        title: 'Squabble',
        message: chinese ? '已是最新版本' : 'Squabble is up to date',
        detail: chinese ? `当前版本：${app.getVersion()}` : `Current version: ${app.getVersion()}`,
      });
    return;
  }
  const choice = await dialog.showMessageBox({
    type: 'info',
    title: 'Squabble',
    message: chinese ? `发现新版本 ${version}` : `Version ${version} is available`,
    detail: chinese
      ? '下载后可以立即重启安装，数据会保留。'
      : 'Download and restart to install. Your data will be kept.',
    buttons: chinese ? ['下载更新', '稍后'] : ['Download update', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response !== 0) return;
  const progress = (_event: { percent: number }) => window?.setProgressBar(_event.percent / 100);
  autoUpdater.on('download-progress', progress);
  try {
    await autoUpdater.downloadUpdate();
  } finally {
    autoUpdater.off('download-progress', progress);
    window?.setProgressBar(-1);
  }
  const install = await dialog.showMessageBox({
    type: 'info',
    title: 'Squabble',
    message: chinese ? '更新已下载' : 'Update downloaded',
    detail: chinese
      ? '现在重启 Squabble 以完成安装？'
      : 'Restart Squabble now to finish installing?',
    buttons: chinese ? ['重启并安装', '稍后'] : ['Restart and install', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (install.response === 0) {
    await stopServices();
    quitAllowed = true;
    autoUpdater.quitAndInstall(false, true);
  }
}

async function showUpdateCheck(silent = false): Promise<void> {
  if (checkingForUpdate) return;
  checkingForUpdate = true;
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  try {
    if (isAutomaticUpdateSupported(process.platform, process.arch, app.isPackaged)) {
      await showWindowsUpdateCheck(chinese, silent);
      return;
    }
    const update = await checkForUpdate(app.getVersion(), process.platform, process.arch);
    if (!update) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Squabble',
        message: chinese ? '已是最新版本' : 'Squabble is up to date',
        detail: chinese ? `当前版本：${app.getVersion()}` : `Current version: ${app.getVersion()}`,
      });
      return;
    }
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'Squabble',
      message: chinese ? `发现新版本 ${update.version}` : `Version ${update.version} is available`,
      detail:
        update.notes ||
        (chinese ? '查看发布页面了解更新内容。' : 'See the release page for details.'),
      buttons: chinese ? ['打开下载页面', '稍后'] : ['Open download page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) await shell.openExternal(update.downloadUrl);
  } catch {
    if (!silent)
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Squabble',
        message: chinese ? '检查更新失败' : 'Could not check for updates',
        detail: chinese
          ? '请检查网络连接，或前往 GitHub Releases 页面查看。'
          : 'Check your connection or visit Squabble Releases on GitHub.',
      });
  } finally {
    checkingForUpdate = false;
  }
}

function installApplicationMenu(): void {
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : [{ label: chinese ? '文件' : 'File', submenu: [{ role: 'quit' as const }] }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: chinese ? '帮助' : 'Help',
      submenu: [
        {
          label: chinese ? '本地 Agent 助手…' : 'Local Agent Companion…',
          click: () => {
            void showCompanionStatus();
          },
        },
        {
          label: chinese ? '检查更新…' : 'Check for Updates…',
          click: () => {
            void showUpdateCheck();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function markSmokeStage(stage: string): void {
  const root = process.env.SQUABBLE_DESKTOP_DATA_DIR;
  if (process.env.SQUABBLE_DESKTOP_SMOKE !== '1' || !root || !isAbsolute(root)) return;
  try {
    appendFileSync(join(root, 'packaged-smoke-stage.log'), `${stage}\n`, { mode: 0o600 });
  } catch {
    // 诊断写入绝不影响应用启动流程。
  }
}

async function stopBackend(): Promise<void> {
  if (!backend) return;
  const child = backend;
  backend = null;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  backendLog?.end();
  backendLog = null;
}

async function stopServices(): Promise<void> {
  if (stoppingServices) return stoppingServices;
  quitting = true;
  stoppingServices = (async () => {
    await companion?.stop();
    await stopBackend();
    if (database) {
      const current = database;
      database = null;
      await current.stop();
    }
  })();
  return stoppingServices;
}

function externalLink(value: string, ownOrigin: string): void {
  try {
    const target = new URL(value);
    if (
      target.origin !== ownOrigin &&
      (target.protocol === 'https:' || target.protocol === 'http:')
    ) {
      void shell.openExternal(target.toString());
    }
  } catch {
    // 无效 URL 既不放进应用窗口，也不交给操作系统打开。
  }
}

async function startDesktop(): Promise<void> {
  markSmokeStage('start-desktop');
  // 解析数据根目录：SQUABBLE_DESKTOP_DATA_DIR 可覆盖（必须是绝对路径），默认用 Electron userData。
  const override = process.env.SQUABBLE_DESKTOP_DATA_DIR;
  if (override && !isAbsolute(override)) throw new Error('Desktop data directory must be absolute');
  const dataRoot = override ?? app.getPath('userData');
  // 非烟测模式下先启动本地 Agent 伴侣，再取目录布局与机密文件。
  if (process.env.SQUABBLE_DESKTOP_SMOKE !== '1') await startCompanion(dataRoot);
  const paths = desktopPaths(app.getAppPath(), dataRoot);
  const secrets = await loadOrCreateSecrets(paths.secretsFile);
  markSmokeStage('before-database');
  // 启动内嵌 PostgreSQL，拿回连接串后再取回环端口并组装后端环境变量。
  database = await startDesktopDatabase(paths, secrets);
  markSmokeStage('after-database');
  const port = await loadOrCreateServerPort(paths.serverPortFile);
  const origin = `http://127.0.0.1:${port}`;
  const environment = nestEnvironment(paths, secrets, database.connectionUrl, port);

  markSmokeStage('before-backend-fork');
  // fork 后端子进程：stdout/stderr 并入 backend.log；异常退出时提示用户并退出应用。
  backendLog = createWriteStream(join(paths.logsDir, 'backend.log'), { flags: 'a', mode: 0o600 });
  backendLog.on('error', () => undefined);
  backend = utilityProcess.fork(paths.serverEntry, [], {
    cwd: paths.resourceRoot,
    env: environment,
    stdio: 'pipe',
  });
  markSmokeStage('after-backend-fork');
  backend.on('spawn', () => markSmokeStage('backend-spawned'));
  backend.stdout?.pipe(backendLog, { end: false });
  backend.stderr?.pipe(backendLog, { end: false });
  backend.on('exit', () => {
    markSmokeStage('backend-exited');
    if (!quitting) {
      dialog.showErrorBox(
        'Squabble stopped',
        'The local server exited. See the log in your Squabble data folder.',
      );
      app.quit();
    }
  });
  // 等待后端健康检查通过与"子进程提前退出"竞速：任一先发生就结束等待。
  await Promise.race([
    waitForHealth(origin, 45_000),
    new Promise<never>((_resolve, reject) =>
      backend?.once('exit', () => reject(new Error('Local server exited during startup'))),
    ),
  ]);
  markSmokeStage('server-healthy');

  // 烟测分支：校验"全新数据目录的首启注册可用"，写标记文件后退出，不创建窗口。
  if (process.env.SQUABBLE_DESKTOP_SMOKE === '1') {
    if (isAutomaticUpdateSupported(process.platform, process.arch, app.isPackaged)) {
      await import('electron-updater');
      markSmokeStage('updater-loaded');
    }
    const response = await fetch(`${origin}/api/auth/registration-status`);
    if (
      !response.ok ||
      ((await response.json()) as { registrationOpen?: boolean }).registrationOpen !== true
    ) {
      throw new Error('Packaged desktop first-run registration is unavailable');
    }
    await writeFile(
      join(dataRoot, 'packaged-smoke.json'),
      JSON.stringify({
        healthy: true,
        registrationOpen: true,
        defaultDataRoot: app.getPath('userData'),
      }),
    );
    markSmokeStage('smoke-marker-written');
    app.quit();
    return;
  }

  // 正常分支：拒绝所有权限请求；创建主窗口（contextIsolation+sandbox，无 preload），
  // 导航与弹窗只放行本站 origin，其余一律转交外部浏览器。
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    externalLink(url, origin);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      allowed = new URL(url).origin === origin;
    } catch {
      /* 无法解析的导航地址一律按不允许处理 */
    }
    if (!allowed) {
      event.preventDefault();
      externalLink(url, origin);
    }
  });
  window.once('ready-to-show', () => window?.show());
  await window.loadURL(origin);
  // 支持自动更新的平台：启动 20 秒后静默检查一次，之后每 6 小时复查。
  if (isAutomaticUpdateSupported(process.platform, process.arch, app.isPackaged)) {
    setTimeout(() => {
      if (!quitting) void showUpdateCheck(true);
    }, 20_000).unref();
    setInterval(
      () => {
        if (!quitting) void showUpdateCheck(true);
      },
      6 * 60 * 60_000,
    ).unref();
  }
}

markSmokeStage('module-loaded');
app.setName('Squabble');
app.on('open-url', (event, url) => {
  event.preventDefault();
  queuePairingLink(url);
});

markSmokeStage('before-single-instance-lock');
// 单实例锁：抢不到锁的实例直接退出；首个实例转发后续实例带来的配对链接并聚焦窗口。
const singleInstance = app.requestSingleInstanceLock();
markSmokeStage(`single-instance-lock-${singleInstance ? 'acquired' : 'denied'}`);
if (!singleInstance) {
  app.quit();
} else {
  for (const argument of process.argv) queuePairingLink(argument);
  app.on('second-instance', (_event, argv) => {
    for (const argument of argv) queuePairingLink(argument);
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitAllowed) return;
    event.preventDefault();
    void stopServices().finally(() => {
      quitAllowed = true;
      app.quit();
    });
  });
  markSmokeStage('before-when-ready');
  void app
    .whenReady()
    .then(() => {
      markSmokeStage('after-when-ready');
      if (process.env.SQUABBLE_DESKTOP_SMOKE !== '1') {
        if (app.isPackaged) app.setAsDefaultProtocolClient('squabble');
        else if (process.defaultApp && process.argv[1]) {
          app.setAsDefaultProtocolClient('squabble', process.execPath, [resolve(process.argv[1])]);
        }
      }
      installApplicationMenu();
      return startDesktop();
    })
    .catch(async (error: unknown) => {
      markSmokeStage('startup-error');
      dialog.showErrorBox(
        'Squabble could not start',
        error instanceof Error ? error.message : String(error),
      );
      await stopServices();
      app.quit();
    });
}
