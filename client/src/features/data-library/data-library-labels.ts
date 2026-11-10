import type { DataFinancialOperation, DataLibrarySourceKind, DataLibraryState } from '@shared/data-library.interface';

export function materialKind(kind: DataLibrarySourceKind, zh: boolean) {
  return ({ page: ['页面', 'Page'], website: ['站点', 'Website'], slides: ['幻灯片', 'Slides'], image: ['图像', 'Image'], file: ['文件', 'File'] })[kind][zh ? 0 : 1];
}

export function materialState(state: DataLibraryState, zh: boolean) {
  return ({ pending: ['待同步', 'Pending'], ready: ['已入库', 'Saved'], syncing: ['同步中', 'Syncing'], 'needs-auth': ['需重新登录', 'Sign-in required'], failed: ['同步失败', 'Failed'], paused: ['已暂停', 'Paused'], 'needs-text': ['已保存 · 未 OCR', 'Saved · No OCR'] })[state][zh ? 0 : 1];
}

export function operationLabel(operation: DataFinancialOperation, zh: boolean) {
  return ({ quote: ['行情', 'Quote'], 'daily-history': ['历史日线', 'Daily history'], financials: ['财报与基本面', 'Financials'], news: ['新闻', 'News'] })[operation][zh ? 0 : 1];
}

export function dataTime(value: string | null | undefined, language: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString(language);
}

/** Do not display HTTP request objects: they can contain write-only credentials. */
export function dataError(error: unknown, zh: boolean) {
  const response = (error as { response?: { status?: number; data?: { code?: string; message?: string } } })?.response;
  const status = response?.status;
  const code = response?.data?.code || response?.data?.message;
  if (code && dataFailureMessages[code]) return dataFailureMessages[code][zh ? 0 : 1];
  if (status === 413) return zh ? '文件过大，请使用不超过 8 MiB 的文件。' : 'Choose a file no larger than 8 MiB.';
  if (status === 404) return zh ? '这份资料已不可用，请刷新列表。' : 'This source is no longer available. Refresh the list.';
  if (status === 409) return zh ? '资料正在同步或已发生变化，请刷新后重试。' : 'The source is syncing or has changed. Refresh and retry.';
  return zh ? '操作未完成。请检查内容、来源地址和凭据后重试。' : 'The action did not complete. Check the content, source address and credentials, then retry.';
}

const dataFailureMessages: Record<string, [string, string]> = {
  NEEDS_AUTH: ['网站要求登录，请更新授权或重新连接浏览器后采集。', 'The site requires sign-in. Renew authorization or reconnect the browser, then capture again.'],
  TIMEOUT: ['页面加载超时。请稍后重试，或在专用浏览器中检查页面是否可正常打开。', 'The page took too long to load. Retry later, or check the page in the dedicated browser.'],
  NETWORK_ERROR: ['暂时无法连接网站，请检查网络后重试。', 'The site could not be reached. Check the network and retry.'],
  BLOCKED: ['该地址或页面请求被安全规则阻止，请检查来源地址。', 'This address or page request was blocked. Check the source URL.'],
  RESPONSE_TOO_LARGE: ['页面内容超过采集上限，请使用更具体的页面地址。', 'The page exceeds the capture size limit. Use a more specific page URL.'],
  EMPTY_CONTENT: ['没有取得可用正文。请检查页面地址和登录状态。', 'No readable content was found. Check the page URL and sign-in status.'],
  NO_CONTENT: ['没有取得可用正文。请检查页面地址和登录状态。', 'No readable content was found. Check the page URL and sign-in status.'],
  CREDENTIAL_UNREADABLE: ['保存的登录信息已无法读取，请重新连接或更新授权。', 'The saved sign-in data cannot be read. Reconnect or renew authorization.'],
  BROWSER_SESSION_CHANGED: ['浏览器连接已更新，这次采集已取消。请使用新连接重新采集。', 'The browser connection changed, so this capture was cancelled. Capture again with the new connection.'],
  BROWSER_SESSION_DISCONNECTED: ['浏览器连接已断开，这次采集已取消。重新连接后可以采集。', 'The browser was disconnected, so this capture was cancelled. Reconnect before capturing again.'],
  SYNC_INTERRUPTED: ['上次采集被中断，可以重新采集。', 'The previous capture was interrupted. You can capture again.'],
  RATE_LIMITED: ['网站暂时限制请求频率，请稍后再采集。', 'The site is limiting requests. Try capturing again later.'],
  CANCELLED: ['采集已取消，可以稍后重新采集。', 'Capture was cancelled. You can capture again later.'],
  BUSY: ['浏览器正在处理其他操作，请稍后重试。', 'The browser is busy. Wait for the current action, then retry.'],
  UNAVAILABLE: ['浏览器暂不可用，请在运行服务的电脑上检查浏览器安装与配置。', 'The browser is unavailable. Check browser installation and configuration on the server computer.'],
  BROWSER_NOT_INSTALLED: ['浏览器尚未安装，请在运行服务的电脑上安装采集浏览器后重试。', 'The capture browser is not installed. Install it on the server computer and retry.'],
  BROWSER_SANDBOX_UNAVAILABLE: ['采集浏览器无法在当前运行环境中安全启动。请检查服务端浏览器运行环境。', 'The capture browser cannot start safely in this environment. Check the server browser runtime.'],
  LOCAL_MODE_REQUIRED: ['登录窗口需要本地运行模式。请在有桌面环境的电脑上运行 Squabble。', 'The sign-in window requires local mode. Run Squabble on a computer with a desktop session.'],
  INTERACTIVE_DISPLAY_UNAVAILABLE: ['服务端没有可交互的桌面，无法显示登录窗口。请在有桌面的电脑上完成连接。', 'The server has no interactive desktop for the sign-in window. Connect from a computer with a desktop session.'],
  BROWSER_LOGIN_UNAVAILABLE: ['服务端无法打开交互式登录窗口。请在有桌面环境的电脑上运行 Squabble。', 'The server cannot open an interactive sign-in window. Run Squabble on a computer with a desktop session.'],
  BROWSER_LOGIN_LOCAL_ONLY: ['请从运行 Squabble 的电脑打开应用，再启动登录窗口。', 'Open Squabble on the server computer to start the sign-in window.'],
  BROWSER_SOURCE_REQUIRED: ['请先将采集方式保存为浏览器，再连接。', 'Save Browser as the collection method before connecting.'],
  SOURCE_CHANGED: ['订阅设置已变化，请刷新并保存后重试。', 'Subscription settings changed. Refresh and save before retrying.'],
};

/** Error codes are a whitelist; never render provider messages or request details. */
export function dataFailure(code: string | null | undefined, zh: boolean) {
  return code && dataFailureMessages[code]
    ? dataFailureMessages[code][zh ? 0 : 1]
    : zh ? '采集未完成。请检查页面和连接状态后重试。' : 'Capture did not complete. Check the page and connection, then retry.';
}

export function safeSourceUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
