/**
 * 静态资源中间件 —— 面向自托管单域名（single-origin）部署。
 *
 * 职责边界：从 `dist/client` 托管已构建的 SPA 产物：`/assets` 下的带 hash
 * 资源，外加 favicon/logo 等公共文件。行为对齐已下线的 platform 中间件
 * （仅 GET/HEAD、ETag + 304、按扩展名给 MIME、路径穿越防护），没有任何 CDN
 * 间接层。`*.html` 文件刻意跳过，SPA 页面壳仍由 view controller 负责。
 *
 * 上下游：import node:crypto/node:fs/path 与 express 类型；被 server/main.ts
 * 以 app.use() 挂载（传根目录 dist/client）。
 *
 * 关键约定（从代码读出）：
 * - ETag = md5(mtimeMs-size) 的 hex 加引号，仅依据文件修改时间与大小；
 * - Cache-Control 为 public, max-age=0, must-revalidate —— 强制每次用
 *   If-None-Match 协商，命中则 304；
 * - 未知扩展名回退 application/octet-stream。
 */
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { Request, RequestHandler, Response } from 'express';
import { join, normalize, resolve, extname } from 'path';

// 按扩展名映射 Content-Type（覆盖构建产物的全部常见类型）。
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

/** 由 mtimeMs + size 生成弱依赖内容的 ETag（md5 hex，外加双引号）。 */
function generateETag(mtimeMs: number, size: number): string {
  const hash = createHash('md5').update(`${mtimeMs}-${size}`).digest('hex');
  return `"${hash}"`;
}

/** 为给定根目录构建静态文件服务（返回 Express 中间件）。 */
export function staticAssets(rootDir: string): RequestHandler {
  const root = resolve(rootDir);
  return function staticAssetsMiddleware(req: Request, res: Response, next: () => void): void {
    // 第 1 步：方法过滤 —— 只服务 GET/HEAD，其余一律放行给后续中间件。
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // 第 2 步：路径过滤 —— 空路径与 *.html 交给 view controller（SPA 壳）。
    const rel = (req.path || '/').replace(/^\/+/, '');
    if (!rel || rel.toLowerCase().endsWith('.html')) return next();

    // 第 3 步：路径穿越防护 —— normalize + join 后必须仍在根目录内
    // （按平台分隔符做前缀检查），逃逸出根目录的请求直接放行 404。
    const filePath = normalize(join(root, rel));
    const separator = process.platform === 'win32' ? '\\' : '/';
    if (filePath !== root && !filePath.startsWith(root + separator)) {
      return next();
    }

    // 第 4 步：探测目标。不存在/无法 stat/不是普通文件都放行（后续按 404 处理）。
    let stat: { mtimeMs: number; size: number; isFile(): boolean };
    try {
      stat = statSync(filePath);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();

    // 第 5 步：协商缓存 —— If-None-Match 与当前 ETag 一致则只回 304，
    // 不再读文件。
    const etag = generateETag(stat.mtimeMs, stat.size);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    // 第 6 步：写响应头 —— MIME 按扩展名（未知类型回退 octet-stream）、
    // 精确 Content-Length、ETag、以及强制协商的 Cache-Control。
    res.setHeader(
      'Content-Type',
      MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    );
    res.setHeader('Content-Length', stat.size);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

    // 第 7 步：输出内容 —— HEAD 只需要头；GET 用流式读取，读取出错时若
    // 响应头未发出则补 500（已经发出就只能中断响应）。
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
