/**
 * 应用入口（bootstrap）。
 *
 * 职责边界：只负责 NestJS（Express）应用的创建与启动 —— 用 Squabble 第一方
 * 技术栈装配：全局鉴权 guard（JWT）、直连 Drizzle 的数据库连接、JSON body
 * 体积上限、以及为构建产物 SPA 服务的自托管静态资源中间件；不含任何业务路由
 * 逻辑，业务 REST API 全部挂在 `/api` 下，SPA 页面壳由 view controller 从
 * `dist/client` 渲染。
 *
 * 上下游：import 根模块 AppModule（./app.module）与静态资源中间件
 * staticAssets（./common/platform/static-assets.middleware）；不导出任何成员，
 * 由 npm scripts（dev:server / start）直接执行本文件。
 *
 * 关键约定（均从代码读出）：
 * - 监听地址/端口来自环境变量 SERVER_HOST / SERVER_PORT，默认 0.0.0.0 / 3000；
 * - JSON 与 urlencoded body 上限均为 1mb（深度报告可能很大）；
 * - 仅当 TRUST_PROXY === 'true' 时设置 Express 'trust proxy' 为 1；
 * - 仅当 NODE_ENV === 'development' 时 abortOnError 为 false（dev 不因
 *   bootstrap 失败而退出进程）；其余环境照常中止；
 * - SQUABBLE_DESKTOP_ORIGIN 存在时，启用桌面壳的 loopback origin 请求防护。
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RequestHandler } from 'express';
import { AppModule } from './app.module';
import { staticAssets } from './common/platform/static-assets.middleware';

/**
 * 构建并启动 NestJS 服务。
 *
 * 开发环境容忍依赖解析错误而不中止（abortOnError=false），让 dev server 保持
 * 运行；其余环境在 bootstrap 出错时照常中止。host/port 读取
 * SERVER_HOST/SERVER_PORT 环境变量，默认 0.0.0.0/3000。
 */
async function bootstrap() {
  // 创建 Nest 应用实例：是否容忍 bootstrap 失败由 NODE_ENV 决定（见上）。
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
  });
  app.enableShutdownHooks();
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  if (process.env.SQUABBLE_DESKTOP_ORIGIN) {
    // 桌面壳把 SPA 跑在一个私有 loopback origin 上：在任何路由之前拒绝
    // DNS-rebound 的 Host 与跨源浏览器请求。动态 import 桌面侧 cjs 守卫。
    const { desktopRequestGuard } = (await import('../desktop/loopback.cjs')) as {
      desktopRequestGuard: (origin: string) => RequestHandler;
    };
    app.use(desktopRequestGuard(process.env.SQUABBLE_DESKTOP_ORIGIN));
  }

  // JSON body 上限 1mb（深度报告可能较大）；urlencoded 同限以保持一致。
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  // 从 dist/client 托管已构建的 SPA 产物（带 hash 的资源、favicon、logo）。
  app.use(staticAssets(join(process.cwd(), 'dist/client')));

  const logger = new Logger('Bootstrap');
  const host = process.env.SERVER_HOST || '0.0.0.0';
  const port = Number(process.env.SERVER_PORT || '3000');

  // 注册视图引擎，让 dist/client 中已构建的 HTML 页面可以被渲染。模板目前
  // 没有占位符，但 hbs 管线为将来注入服务端 locals 留了口子。
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  await app.listen(port, host);
  logger.log(`Squabble server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
}

bootstrap();
