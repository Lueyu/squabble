/**
 * Platform compatibility layer — the single import surface that used to be
 * `@lark-apaas/fullstack-nestjs-core`.
 *
 * Business modules import { DRIZZLE_DATABASE, NeedLogin, PostgresJsDatabase }
 * from '@server/common/platform' (resolved via tsconfig paths in dev, and via
 * relative rewrites in the built output). Everything platform-specific
 * (gateway auth, datapaas role switching, CSRF, hot-update HTML) is gone:
 * auth is first-party JWT, the database is a direct Drizzle connection, and
 * static assets are served by our own middleware.
 */
export { DRIZZLE_DATABASE, DatabaseModule, createDatabase } from './database.provider';
export type { SquabbleDatabase, PostgresJsDatabase } from './database.provider';
export { NeedLogin, NEED_LOGIN_KEY } from './need-login.decorator';
export { AuthGlobalGuard } from './auth.guard';
export { staticAssets } from './static-assets.middleware';
export { simpleExperienceEnabled, simpleExperienceEnvironmentEnabled } from './simple-experience';
