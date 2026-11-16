/**
 * Static assets middleware for the self-hosted single-origin deployment.
 *
 * Serves the built SPA bundle from `dist/client`: hashed assets under
 * `/assets`, plus favicon/logo and other public files. Mirrors the behavior
 * of the retired platform middleware (GET/HEAD only, ETag + 304, MIME by
 * extension, path traversal guard) without any CDN indirection.
 *
 * `*.html` files are intentionally skipped so the view controller keeps
 * handling the SPA shell.
 */
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { Request, RequestHandler, Response } from 'express';
import { join, normalize, resolve, extname } from 'path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

function generateETag(mtimeMs: number, size: number): string {
  const hash = createHash('md5').update(`${mtimeMs}-${size}`).digest('hex');
  return `"${hash}"`;
}

/** Build the static file server for the given root directory. */
export function staticAssets(rootDir: string): RequestHandler {
  const root = resolve(rootDir);
  return function staticAssetsMiddleware(req: Request, res: Response, next: () => void): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const rel = (req.path || '/').replace(/^\/+/, '');
    if (!rel || rel.toLowerCase().endsWith('.html')) return next();

    const filePath = normalize(join(root, rel));
    const separator = process.platform === 'win32' ? '\\' : '/';
    if (filePath !== root && !filePath.startsWith(root + separator)) {
      return next();
    }

    let stat: { mtimeMs: number; size: number; isFile(): boolean };
    try {
      stat = statSync(filePath);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();

    const etag = generateETag(stat.mtimeMs, stat.size);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader(
      'Content-Type',
      MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    );
    res.setHeader('Content-Length', stat.size);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  };
}
