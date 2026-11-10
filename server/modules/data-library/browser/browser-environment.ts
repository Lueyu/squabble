import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { BrowserSourceError, type BrowserAvailability } from './browser-source.types';

export async function browserExecutable(): Promise<string | undefined> {
  const candidates = [
    chromium.executablePath(),
    ...(process.platform === 'win32' ? [
      `${process.env.PROGRAMFILES ?? 'C:/Program Files'}/Google/Chrome/Application/chrome.exe`,
      `${process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'}/Google/Chrome/Application/chrome.exe`,
      `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
    ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']),
  ];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next supported installation. */ }
  }
  return undefined;
}

export async function inspectBrowserEnvironment(): Promise<BrowserAvailability> {
  const executable = await browserExecutable();
  const sandboxAllowed = process.platform !== 'linux' || process.getuid?.() !== 0;
  const available = Boolean(executable) && sandboxAllowed;
  const localMode = process.env.AUTH_MODE === 'local'
    && ['127.0.0.1', '::1', 'localhost'].includes(process.env.SERVER_HOST ?? '');
  const graphical = process.platform === 'win32' || process.platform === 'darwin'
    || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return {
    available,
    canOpenInteractive: available && localMode && graphical,
    reason: !executable ? 'BROWSER_NOT_INSTALLED' : !sandboxAllowed ? 'BROWSER_SANDBOX_UNAVAILABLE'
      : !localMode ? 'LOCAL_MODE_REQUIRED' : !graphical ? 'INTERACTIVE_DISPLAY_UNAVAILABLE' : undefined,
  };
}

function upstreamUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.includes('://') ? value : `http://${value}`); }
  catch { throw new BrowserSourceError('UNAVAILABLE'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash || url.search
    || url.pathname !== '/') throw new BrowserSourceError('UNAVAILABLE');
  return url;
}

/** Uses private process/system proxy settings without printing URLs or credentials. NO_PROXY cannot bypass this egress. */
export async function configuredBrowserUpstream(): Promise<URL | undefined> {
  const configured = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (configured) return upstreamUrl(configured);
  if (process.platform !== 'win32') return undefined;
  const settings = await new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$p = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{ enabled = [bool]$p.ProxyEnable; server = [string]$p.ProxyServer; pac = [string]$p.AutoConfigURL } | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 3000, maxBuffer: 8192 }, (error, stdout) => {
      if (error) reject(new BrowserSourceError('UNAVAILABLE')); else resolve(stdout);
    });
  });
  let parsed: unknown;
  try { parsed = JSON.parse(settings); } catch { throw new BrowserSourceError('UNAVAILABLE'); }
  if (!parsed || typeof parsed !== 'object') throw new BrowserSourceError('UNAVAILABLE');
  const config = parsed as { enabled?: boolean; server?: string; pac?: string };
  if (config.enabled && config.server) {
    const entries = config.server.split(';');
    const https = entries.find(entry => entry.startsWith('https='));
    const http = entries.find(entry => entry.startsWith('http='));
    const value = https?.slice(6) || http?.slice(5) || (entries.length === 1 && !entries[0].includes('=') ? entries[0] : '');
    if (!value) throw new BrowserSourceError('UNAVAILABLE');
    return upstreamUrl(value);
  }
  if (config.pac) throw new BrowserSourceError('UNAVAILABLE');
  return undefined;
}
