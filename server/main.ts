/**
 * Application entry point.
 *
 * Bootstraps the NestJS (Express) application with Squabble's first-party
 * stack: the global auth guard (JWT), the direct Drizzle database connection,
 * JSON body limits, and the self-hosted static assets middleware for the
 * built SPA. All business REST APIs live under `/api`; the SPA shell is
 * rendered by the view controller from `dist/client`.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RequestHandler } from 'express';
import { importBodyParsers } from './modules/import/screenshot-body-parser';
import { AppModule } from './app.module';
import { staticAssets } from './common/platform/static-assets.middleware';
import { isLocalWorkspaceMode, localWorkspaceRequestGuard, validateLocalWorkspaceConfig } from './modules/auth/local-workspace';

/**
 * Builds and starts the NestJS server.
 *
 * In development the process tolerates a dependency-resolution error instead
 * of aborting (`abortOnError`), which lets the dev server keep running; in
 * other environments it aborts on bootstrap errors as usual. Host/port are
 * read from `SERVER_HOST`/`SERVER_PORT` env vars with `0.0.0.0`/`3000`
 * defaults.
 */
async function bootstrap() {
  validateLocalWorkspaceConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
    bodyParser: false,
  });
  app.enableShutdownHooks();
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  if (isLocalWorkspaceMode()) app.use(localWorkspaceRequestGuard());

  if (process.env.SQUABBLE_DESKTOP_ORIGIN) {
    // The desktop shell serves the SPA on a private loopback origin. Reject
    // DNS-rebound hosts and cross-origin browser requests before any routes.
    const { desktopRequestGuard } = await import('../desktop/loopback.cjs') as {
      desktopRequestGuard: (origin: string) => RequestHandler;
    };
    app.use(desktopRequestGuard(process.env.SQUABBLE_DESKTOP_ORIGIN));
  }

  // Screenshot and library uploads need space for an 8MiB file encoded as base64.
  // Other bodies remain limited to 1MB. Keep every parser on the same version.
  app.use(...importBodyParsers());

  // Serve the built SPA bundle (hashed assets, favicon, logo) from dist/client.
  app.use(staticAssets(join(process.cwd(), 'dist/client')));

  const logger = new Logger('Bootstrap');
  const host = process.env.SERVER_HOST || '0.0.0.0';
  const port = Number(process.env.SERVER_PORT || '3000');

  // Register the view engine so the built client HTML pages in dist/client
  // can be rendered. The template contains no placeholders today, but the
  // hbs pipeline keeps the door open for server-injected locals.
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  await app.listen(port, host);
  logger.log(`Squabble server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
}

bootstrap();
