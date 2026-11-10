import type { BrowserContext, Page } from 'playwright-core';
import { BrowserSourceError } from './browser-source.types';

export interface RenderedBrowserContent { url: string; title: string; text: string; html: Buffer }

/** Shared by persistence and live capture so newly rotated secrets obey the same privacy rule. */
export function browserSessionSecretValues(state: unknown): string[] {
  const secrets = new Set<string>();
  const sensitiveName = /token|session|auth|secret|credential|password|jwt|csrf|(?:^|[-_])(?:key|sid)(?:$|[-_])/iu;
  const collect = (value: unknown, name: string, depth = 0): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      if (value.length >= 4 && (sensitiveName.test(name) || value.length >= 16 && !/\s/u.test(value))) {
        secrets.add(value);
        secrets.add(encodeURIComponent(value));
        try { secrets.add(decodeURIComponent(value)); } catch { /* Already a literal value. */ }
      }
      if (/^[{[]/u.test(value)) {
        try { collect(JSON.parse(value), name, depth + 1); } catch { /* Plain local-storage text. */ }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, name, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) collect(item, key, depth + 1);
    }
  };
  if (!state || typeof state !== 'object') return [];
  const session = state as { cookies?: unknown[]; origins?: unknown[] };
  const collectEntry = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as { name?: unknown; value?: unknown };
    collect(record.value, typeof record.name === 'string' ? record.name : '');
  };
  if (Array.isArray(session.cookies)) for (const entry of session.cookies) collectEntry(entry);
  if (Array.isArray(session.origins)) {
    for (const origin of session.origins) {
      if (origin && typeof origin === 'object' && 'localStorage' in origin && Array.isArray(origin.localStorage)) {
        for (const entry of origin.localStorage) collectEntry(entry);
      }
    }
  }
  if (secrets.size > 2048) throw new BrowserSourceError('RESPONSE_TOO_LARGE');
  return [...secrets].filter(value => value.length >= 4).sort((a, b) => b.length - a.length);
}

export function redactBrowserSessionValues(input: string, state: unknown): string {
  let output = input;
  for (const secret of browserSessionSecretValues(state)) output = output.split(secret).join('[redacted]');
  return output;
}

export function redactBrowserContent(
  content: RenderedBrowserContent,
  state: Awaited<ReturnType<BrowserContext['storageState']>>,
): RenderedBrowserContent & { url: string } {
  const title = redactBrowserSessionValues(content.title, state);
  const text = redactBrowserSessionValues(content.text, state);
  return { title, text, html: renderedTextHtml(title, text), url: redactBrowserSessionValues(content.url, state) };
}

function renderedTextHtml(title: string, text: string): Buffer {
  const escape = (value: string): string => value.replace(/[&<>"']/gu, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
  return Buffer.from(`<!doctype html><html><head><title>${escape(title)}</title></head><body><main>${escape(text)}</main></body></html>`);
}

export async function extractBrowserContent(page: Page): Promise<RenderedBrowserContent> {
  const rendered = await page.evaluate(() => {
    const body = document.body;
    const challenge = Boolean(document.querySelector('input[type="password"], iframe[src*="captcha"], [class*="paywall"], [id*="paywall"]'));
    const text = body?.innerText ?? '';
    const gated = /(?:sign in|log in|subscribe) to (?:continue|read|access)|verify (?:you are|that you are|you're) human|checking your browser|complete the captcha|enable javascript|登录后(?:查看|阅读)|请先登录|订阅后(?:查看|阅读)|人机验证|安全验证/iu.test(text)
      || /\/(?:login|signin|sign-in|auth)(?:\/|$|[?#])/iu.test(location.href);
    const selected = document.querySelector('main article, article, main, [role="main"]') ?? body;
    const clone = selected?.cloneNode(true) as HTMLElement | undefined;
    clone?.querySelectorAll('script, style, nav, header, footer, aside, form, input, button, select, textarea, [hidden], [aria-hidden="true"], [role="navigation"], [aria-label*="account" i], [class*="account-menu"], [class*="cookie-banner"]').forEach(element => element.remove());
    const content = (clone?.innerText || clone?.textContent || '').replace(/\s+/gu, ' ').trim();
    return { url: location.href, challenge: challenge || gated, title: document.title.trim().slice(0, 500), text: content };
  });
  if (rendered.challenge || rendered.text.length < 120) throw new BrowserSourceError('NEEDS_AUTH');
  if (rendered.text.length > 200_000) throw new BrowserSourceError('RESPONSE_TOO_LARGE');
  // This is a bounded representation of rendered text, deliberately not the raw HTTP or executable DOM.
  const html = renderedTextHtml(rendered.title, rendered.text);
  return { url: rendered.url, title: rendered.title, text: rendered.text, html };
}
