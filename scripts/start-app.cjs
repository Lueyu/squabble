/**
 * start-app.cjs — 生产/容器环境的启动包装：先准备全部机密，再加载 NestJS 后端入口。
 *
 * 职责边界：
 *  - PUBLIC_DEPLOYMENT=true 时先做公网部署机密强度自检（JWT/settings/PG 各 ≥32 字符、互不相同、
 *    不能是 replace-with-* 或已知演示值），不过关直接 exit 1。
 *  - 用 ensure-jwt-secret / ensure-settings-key 准备 JWT_SECRET 与 SETTINGS_ENCRYPTION_KEY
 *    （文件落在 /app/.secrets/）；docker 更新模式额外准备 update-token。
 *  - 任何机密准备失败都写 stderr 并 exit 1，绝不带残缺机密启动。
 * 上下游：
 *  - 上游（谁启动）：Dockerfile CMD（"node scripts/start-app.cjs"）；容器/裸机生产部署入口。
 *  - 下游（启动谁/连接什么）：require('../dist/server/main.js') 启动 NestJS 后端（监听 PORT）。
 * 关键约定：
 *  - 进程模型：本文件与后端在同一 Node 进程；umask 0o077 让后续新建文件默认仅属主可读写。
 */
const { ensureSettingsKey } = require('./ensure-settings-key.cjs');
const { ensureJwtSecret } = require('./ensure-jwt-secret.cjs');

process.umask(0o077);
// 公网部署自检：机密强度不足或互相相同直接拒绝启动（错误文案是面向运维的用户可见提示，勿改）。
if (process.env.PUBLIC_DEPLOYMENT === 'true') {
  const jwt = process.env.JWT_SECRET || '';
  const settings = process.env.SETTINGS_ENCRYPTION_KEY || '';
  const pg = process.env.POSTGRES_PASSWORD || '';
  if (
    jwt.length < 32 ||
    settings.length < 32 ||
    pg.length < 32 ||
    jwt === settings ||
    [jwt, settings, pg].some((value) => value.startsWith('replace-with-')) ||
    jwt === 'change-me-in-production-0123456789abcdef'
  ) {
    process.stderr.write(
      'Cannot start public deployment: use independent random database, JWT, and settings secrets (at least 32 characters).\n',
    );
    process.exit(1);
  }
}
try {
  // 解析/持久化机密并回填进程环境变量；失败则写 stderr 后退出。
  process.env.JWT_SECRET = ensureJwtSecret(process.env.JWT_SECRET, '/app/.secrets/jwt.key');
  process.env.SETTINGS_ENCRYPTION_KEY = ensureSettingsKey(
    process.env.SETTINGS_ENCRYPTION_KEY,
    '/app/.secrets/settings.key',
  );
  if (process.env.SQUABBLE_UPDATE_MODE === 'docker') {
    ensureJwtSecret('', '/app/.secrets/update-token');
  }
} catch (error) {
  process.stderr.write(`Cannot start Squabble: ${error.message}\n`);
  process.exit(1);
}

require('../dist/server/main.js');
