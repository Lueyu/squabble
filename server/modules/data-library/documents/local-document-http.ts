export class LocalDocumentHttp {
  readonly base: URL;
  constructor(baseUrl: string, private readonly apiKey?: string, allowedOrigins: string[] = [],
    private readonly auth: 'x-api-key' | 'bearer' = 'x-api-key') {
    this.base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const loopback = ['127.0.0.1', '[::1]'].includes(this.base.hostname);
    if ((!loopback && !allowedOrigins.includes(this.base.origin)) || !['http:', 'https:'].includes(this.base.protocol) ||
      this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('DOCUMENT_LOCAL_ENDPOINT_REQUIRED');
  }
  scopedUrl(path: string): URL {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname) || url.username || url.password || url.hash) {
      throw new Error('DOCUMENT_URL_OUT_OF_SCOPE');
    }
    return url;
  }
  async bytes(path: string, init: RequestInit = {}, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
    const url = this.scopedUrl(path), headers = new Headers(init.headers);
    if (this.apiKey) headers.set(this.auth === 'bearer' ? 'Authorization' : 'X-Api-Key',
      this.auth === 'bearer' ? `Bearer ${this.apiKey}` : this.apiKey);
    const response = await fetch(url, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error(`DOCUMENT_HTTP_${response.status}`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > maxBytes) throw new Error('DOCUMENT_OUTPUT_TOO_LARGE'); chunks.push(part.value);
    } } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks);
  }
  async json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const data = await this.bytes(path, init);
    try { const value: unknown = JSON.parse(data.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
      return value as Record<string, unknown>;
    } catch { throw new Error('DOCUMENT_INVALID_JSON'); }
  }
}
