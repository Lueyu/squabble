/**
 * Platform 兼容层 —— 统一 import 门面，替代旧的
 * `@lark-apaas/fullstack-nestjs-core`。
 *
 * 职责边界：只做再导出（barrel），把平台能力收敛到一个 import 面；
 * 自身无逻辑。
 *
 * 上下游：业务模块从此处 import { DRIZZLE_DATABASE, NeedLogin,
 * PostgresJsDatabase }（dev 经 tsconfig paths 解析为 @server/common/platform，
 * 构建产物经相对路径重写）。一切 platform 专属机制（gateway auth、datapaas
 * 角色切换、CSRF、热更新 HTML）均已移除：鉴权为第一方 JWT，数据库为直连
 * Drizzle，静态资源由自有中间件托管。
 */
export { DRIZZLE_DATABASE, DatabaseModule, createDatabase } from './database.provider';
export type { SquabbleDatabase, PostgresJsDatabase } from './database.provider';
export { NeedLogin, NEED_LOGIN_KEY } from './need-login.decorator';
export { AuthGlobalGuard } from './auth.guard';
export { staticAssets } from './static-assets.middleware';
