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
  if (!parsePairingLink(link) || pendingPairLinks.includes(link) || pendingPairLinks.length >= 3) return;
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
          const choice = await dialog.showMessageBox({ type: 'question', title: 'Squabble',
            message: chinese ? '允许此本地应用使用你的研究 Agent？' : 'Allow this local app to use your research agents?',
            detail: chinese ? `${origin}\n\n连接后，此应用可以使用你的 CLI 登录账号运行 Codex 和 Claude Code 研究任务，可能消耗套餐用量或产生费用。请确认这正是你刚刚在设置中打开的地址。`
              : `${origin}\n\nThis app can run Codex and Claude Code research tasks using your CLI sign-in, which may consume your plan or incur charges. Confirm this is the address you just opened in Settings.`,
            buttons: chinese ? ['连接', '取消'] : ['Connect', 'Cancel'], defaultId: 1, cancelId: 1,
          });
          return choice.response === 0;
        });
        if (paired) await dialog.showMessageBox({ type: 'info', title: 'Squabble',
          message: chinese ? '桌面助手已配对' : 'Desktop companion paired',
          detail: chinese ? '返回网页设置，登录并连接 Codex 或 Claude Code。使用期间请保持桌面应用开启。'
            : 'Return to web Settings to sign in and connect Codex or Claude Code. Keep the desktop app open while using them.',
        });
      } catch {
        await dialog.showMessageBox({ type: 'warning', title: 'Squabble',
          message: chinese ? '无法配对桌面助手' : 'Could not pair the desktop companion',
          detail: chinese ? '确认本地应用正在运行，然后在网页设置中创建新的配对请求。'
            : 'Make sure the local app is running, then create a new pairing request in web Settings.',
        });
      }
    }
  } finally { handlingPairLink = false; }
}

async function showCompanionStatus(): Promise<void> {
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  const status = companion?.status;
  const states = chinese
    ? { unpaired: '尚未配对', connecting: '正在连接', connected: '已连接', offline: '暂时离线，正在重连' }
    : { unpaired: 'Not paired', connecting: 'Connecting', connected: 'Connected', offline: 'Offline; reconnecting' };
  const providerStates = chinese
    ? { not_installed: '未安装', login_required: '需要登录', ready: '已就绪', error: '检测失败' }
    : { not_installed: 'Not installed', login_required: 'Sign-in required', ready: 'Ready', error: 'Detection failed' };
  const details = status ? [
    states[status.state], status.origin ?? '',
    ...status.agents.map((agent) => `${agent.name}: ${providerStates[agent.state]}`),
    chinese ? `正在运行的任务：${status.activeTasks}` : `Running tasks: ${status.activeTasks}`,
    chinese ? '在 Docker 网页的设置中配对或断开助手。使用期间请保持此应用开启。'
      : 'Pair or disconnect the companion in Docker web Settings. Keep this app open while using it.',
  ] : [chinese ? '桌面助手不可用，请重启应用后重试。' : 'The desktop companion is unavailable. Restart the app to retry.'];
  await dialog.showMessageBox({ type: 'info', title: 'Squabble',
    message: chinese ? '本地研究 Agent 助手' : 'Local research agent companion', detail: details.filter(Boolean).join('\n\n') });
}

async function startCompanion(dataRoot: string): Promise<void> {
  try {
    const runtime = createRequire(import.meta.url)(join(app.getAppPath(), 'dist', 'server', 'local-agents', 'native.js')) as NativeRuntime;
    companion = new LocalAgentCompanion({ dataDir: join(dataRoot, 'local-agent-companion'), name: hostname(), native: runtime });
    await companion.restore();
    companion.start();
    void handlePendingPairings();
  } catch {
    companion = null;
    // Pairing storage and CLI diagnostics can contain credentials. Never show raw errors.
    await dialog.showMessageBox({ type: 'warning', title: 'Squabble',
      message: app.getLocale().toLowerCase().startsWith('zh') ? '桌面助手无法启动，请重启应用后重试。'
        : 'The desktop companion could not start. Restart the app to retry.' });
  }
}

async function showWindowsUpdateCheck(chinese: boolean, silent: boolean): Promise<void> {
  // Eager loading electron-updater stalls packaged startup before the app is ready.
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const result = await autoUpdater.checkForUpdates();
  const version = result?.updateInfo.version;
  if (!version || !isNewerVersion(version, app.getVersion())) {
    if (!silent) await dialog.showMessageBox({ type: 'info', title: 'Squabble',
      message: chinese ? '已是最新版本' : 'Squabble is up to date',
      detail: chinese ? `当前版本：${app.getVersion()}` : `Current version: ${app.getVersion()}` });
    return;
  }
  const choice = await dialog.showMessageBox({ type: 'info', title: 'Squabble',
    message: chinese ? `发现新版本 ${version}` : `Version ${version} is available`,
    detail: chinese ? '下载后可以立即重启安装，数据会保留。' : 'Download and restart to install. Your data will be kept.',
    buttons: chinese ? ['下载更新', '稍后'] : ['Download update', 'Later'],
    defaultId: 0, cancelId: 1 });
  if (choice.response !== 0) return;
  const progress = (_event: { percent: number }) => window?.setProgressBar(_event.percent / 100);
  autoUpdater.on('download-progress', progress);
  try {
    await autoUpdater.downloadUpdate();
  } finally {
    autoUpdater.off('download-progress', progress);
    window?.setProgressBar(-1);
  }
  const install = await dialog.showMessageBox({ type: 'info', title: 'Squabble',
    message: chinese ? '更新已下载' : 'Update downloaded',
    detail: chinese ? '现在重启 Squabble 以完成安装？' : 'Restart Squabble now to finish installing?',
    buttons: chinese ? ['重启并安装', '稍后'] : ['Restart and install', 'Later'],
    defaultId: 0, cancelId: 1 });
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
      await dialog.showMessageBox({ type: 'info', title: 'Squabble',
        message: chinese ? '已是最新版本' : 'Squabble is up to date',
        detail: chinese ? `当前版本：${app.getVersion()}` : `Current version: ${app.getVersion()}` });
      return;
    }
    const choice = await dialog.showMessageBox({ type: 'info', title: 'Squabble',
      message: chinese ? `发现新版本 ${update.version}` : `Version ${update.version} is available`,
      detail: update.notes || (chinese ? '查看发布页面了解更新内容。' : 'See the release page for details.'),
      buttons: chinese ? ['打开下载页面', '稍后'] : ['Open download page', 'Later'],
      defaultId: 0, cancelId: 1,
    });
    if (choice.response === 0) await shell.openExternal(update.downloadUrl);
  } catch {
    if (!silent) await dialog.showMessageBox({ type: 'warning', title: 'Squabble',
      message: chinese ? '检查更新失败' : 'Could not check for updates',
      detail: chinese ? '请检查网络连接，或前往 GitHub Releases 页面查看。'
        : 'Check your connection or visit Squabble Releases on GitHub.' });
  } finally {
    checkingForUpdate = false;
  }
}

function installApplicationMenu(): void {
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : [
      { label: chinese ? '文件' : 'File', submenu: [{ role: 'quit' as const }] },
    ]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: chinese ? '帮助' : 'Help', submenu: [
      { label: chinese ? '本地 Agent 助手…' : 'Local Agent Companion…', click: () => { void showCompanionStatus(); } },
      { label: chinese ? '检查更新…' : 'Check for Updates…', click: () => { void showUpdateCheck(); } },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function markSmokeStage(stage: string): void {
  const root = process.env.SQUABBLE_DESKTOP_DATA_DIR;
  if (process.env.SQUABBLE_DESKTOP_SMOKE !== '1' || !root || !isAbsolute(root)) return;
  try {
    appendFileSync(join(root, 'packaged-smoke-stage.log'), `${stage}\n`, { mode: 0o600 });
  } catch {
    // Diagnostics must never change application startup.
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
    if (target.origin !== ownOrigin && (target.protocol === 'https:' || target.protocol === 'http:')) {
      void shell.openExternal(target.toString());
    }
  } catch {
    // Invalid URLs stay inside neither the app nor the operating system.
  }
}

async function startDesktop(): Promise<void> {
  markSmokeStage('start-desktop');
  const override = process.env.SQUABBLE_DESKTOP_DATA_DIR;
  if (override && !isAbsolute(override)) throw new Error('Desktop data directory must be absolute');
  const dataRoot = override ?? app.getPath('userData');
  if (process.env.SQUABBLE_DESKTOP_SMOKE !== '1') await startCompanion(dataRoot);
  const paths = desktopPaths(app.getAppPath(), dataRoot);
  const secrets = await loadOrCreateSecrets(paths.secretsFile);
  markSmokeStage('before-database');
  database = await startDesktopDatabase(paths, secrets);
  markSmokeStage('after-database');
  const port = await loadOrCreateServerPort(paths.serverPortFile);
  const origin = `http://127.0.0.1:${port}`;
  const environment = nestEnvironment(paths, secrets, database.connectionUrl, port);
  if (process.env.SQUABBLE_DESKTOP_SMOKE === '1') environment.LOCAL_WORKSPACE_USER_ID = '';

  markSmokeStage('before-backend-fork');
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
      dialog.showErrorBox('Squabble stopped', 'The local server exited. See the log in your Squabble data folder.');
      app.quit();
    }
  });
  await Promise.race([
    waitForHealth(origin, 45_000),
    new Promise<never>((_resolve, reject) => backend?.once('exit', () => reject(new Error('Local server exited during startup')))),
  ]);
  markSmokeStage('server-healthy');

  if (process.env.SQUABBLE_DESKTOP_SMOKE === '1') {
    if (isAutomaticUpdateSupported(process.platform, process.arch, app.isPackaged)) {
      await import('electron-updater');
      markSmokeStage('updater-loaded');
    }
    const localMode = environment.AUTH_MODE === 'local';
    const mode = await fetch(`${origin}/api/auth/mode`);
    if (!mode.ok || (await mode.json() as { mode?: string }).mode !== environment.AUTH_MODE) {
      throw new Error('Packaged desktop authentication mode does not match its configuration');
    }
    const response = await fetch(`${origin}/api/auth/registration-status`);
    if (!response.ok || (await response.json() as { registrationOpen?: boolean }).registrationOpen !== !localMode) {
      throw new Error('Packaged desktop registration does not match its authentication mode');
    }
    const profile = await fetch(`${origin}/api/auth/me`);
    if (profile.status !== (localMode ? 200 : 401)) {
      throw new Error('Packaged desktop workspace access does not match its authentication mode');
    }
    if (localMode) {
      const registration = await fetch(`${origin}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (registration.status !== 403) throw new Error('Packaged local workspace permits account registration');
    }
    await writeFile(join(dataRoot, 'packaged-smoke.json'), JSON.stringify({
      healthy: true, authMode: environment.AUTH_MODE, registrationOpen: !localMode,
      anonymousAccess: localMode, defaultDataRoot: app.getPath('userData'),
    }));
    markSmokeStage('smoke-marker-written');
    app.quit();
    return;
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
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
    try { allowed = new URL(url).origin === origin; } catch { /* block malformed navigation */ }
    if (!allowed) {
      event.preventDefault();
      externalLink(url, origin);
    }
  });
  window.once('ready-to-show', () => window?.show());
  await window.loadURL(origin);
  if (isAutomaticUpdateSupported(process.platform, process.arch, app.isPackaged)) {
    setTimeout(() => { if (!quitting) void showUpdateCheck(true); }, 20_000).unref();
    setInterval(() => { if (!quitting) void showUpdateCheck(true); }, 6 * 60 * 60_000).unref();
  }
}

markSmokeStage('module-loaded');
app.setName('Squabble');
app.on('open-url', (event, url) => { event.preventDefault(); queuePairingLink(url); });

markSmokeStage('before-single-instance-lock');
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
  void app.whenReady().then(() => {
    markSmokeStage('after-when-ready');
    if (process.env.SQUABBLE_DESKTOP_SMOKE !== '1') {
      if (app.isPackaged) app.setAsDefaultProtocolClient('squabble');
      else if (process.defaultApp && process.argv[1]) {
        app.setAsDefaultProtocolClient('squabble', process.execPath, [resolve(process.argv[1])]);
      }
    }
    installApplicationMenu();
    return startDesktop();
  }).catch(async (error: unknown) => {
    markSmokeStage('startup-error');
    dialog.showErrorBox('Squabble could not start', error instanceof Error ? error.message : String(error));
    await stopServices();
    app.quit();
  });
}
