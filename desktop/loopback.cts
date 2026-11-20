/**
 * loopback.cts — 桌面部署的 HTTP 守卫：只允许桌面壳自己的 127.0.0.1 回环来源访问后端。
 *
 * 职责边界：
 *  - 提供 Express 中间件工厂 desktopRequestGuard(expectedOrigin)：校验请求的 Host 与 Origin 头，
 *    不匹配时直接以 403 Forbidden 短路响应。
 *  - expectedOrigin 必须形如 http://127.0.0.1:<port>，否则工厂构造阶段就抛错拒绝启动。
 * 上下游：
 *  - 上游（谁调用）：server/main.ts 在桌面模式下动态 import('../desktop/loopback.cjs') 并挂载本守卫；
 *    desktop/loopback.spec.ts 直接测试。
 *  - 下游：不发起任何连接；仅拦截。
 * 关键约定：
 *  - 进程模型：本文件编译为 loopback.cjs，随后端 NestJS 进程运行（不是 Electron 主进程）。
 *    桌面窗口加载的页面与后端共用私有回环 origin，浏览器/其他进程来源一律拒绝。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function desktopRequestGuard(
  expectedOrigin: string,
): (request: IncomingMessage, response: ServerResponse, next: () => void) => void {
  const expected = new URL(expectedOrigin);
  if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || !expected.port) {
    throw new Error('Desktop origin must use IPv4 loopback HTTP');
  }
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (
      request.headers.host !== expected.host ||
      (request.headers.origin !== undefined && request.headers.origin !== expected.origin)
    ) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }
    next();
  };
}
