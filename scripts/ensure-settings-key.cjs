/**
 * ensure-settings-key.cjs — 解析并保证 SETTINGS_ENCRYPTION_KEY 可用：优先显式环境变量，其次持久化密钥文件。
 *
 * 职责边界：
 *  - ensureSettingsKey：显式 key 必须 ≥16 字符且不能是已知演示值；未提供时读/建 keyFile（0600，
 *    原子 wx 写入，写冲突时退回读现存文件），存盘值必须是 64 位 hex，否则抛错。
 *  - 该密钥供 server/modules/settings 加密保存用户的第三方 API 密钥。
 * 上下游：
 *  - 上游（谁调用）：scripts/start-app.cjs 在容器/裸机启动时调用（见 Dockerfile CMD）；
 *    scripts/ensure-settings-key.spec.cjs 单测覆盖。
 *  - 下游（连接什么）：把最终机密交给 NestJS 后端进程的环境变量 SETTINGS_ENCRYPTION_KEY。
 * 关键约定：
 *  - 失败即抛错：密钥文件损坏/被替换为非法内容时直接让启动失败，绝不静默换新密钥
 *    （换新会导致已加密的设置数据永久无法解密）。
 */
const { randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const KNOWN_DEMO_SECRET = 'change-me-in-production-0123456789abcdef';

/** 让自动生成的加密密钥在应用重建（rebuild）之后保持稳定。 */
function ensureSettingsKey(explicitKey, keyFile) {
  if (explicitKey) {
    if (explicitKey.length < 16 || explicitKey === KNOWN_DEMO_SECRET) {
      throw new Error('SETTINGS_ENCRYPTION_KEY must be a private value of at least 16 characters');
    }
    return explicitKey;
  }

  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  let stored;
  try {
    stored = readFileSync(keyFile, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = randomBytes(32).toString('hex');
    try {
      writeFileSync(keyFile, `${generated}\n`, { flag: 'wx', mode: 0o600 });
      stored = generated;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      stored = readFileSync(keyFile, 'utf8').trim();
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(stored)) {
    throw new Error(
      'Saved settings encryption key is invalid; restore the settings-secrets volume',
    );
  }
  return stored;
}

module.exports = { ensureSettingsKey };
