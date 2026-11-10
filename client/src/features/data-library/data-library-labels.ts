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
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 413) return zh ? '文件过大，请使用不超过 8 MiB 的文件。' : 'Choose a file no larger than 8 MiB.';
  if (status === 404) return zh ? '这份资料已不可用，请刷新列表。' : 'This source is no longer available. Refresh the list.';
  if (status === 409) return zh ? '资料正在同步或已发生变化，请刷新后重试。' : 'The source is syncing or has changed. Refresh and retry.';
  return zh ? '操作未完成。请检查内容、来源地址和凭据后重试。' : 'The action did not complete. Check the content, source address and credentials, then retry.';
}

export function safeSourceUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
