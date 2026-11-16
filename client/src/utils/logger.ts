/**
 * @file utils/logger.ts
 * @description 极简的第一方日志器。
 *
 * 取代平台工具包自带的 logger：所有输出都落在浏览器 console 上并带
 * [squabble] 前缀。任何东西都不会被外发 —— 无远程日志、无遥测
 * （见 docs/privacy.md）。
 *
 * 职责边界：
 *  - 只包一层 console；不做级别开关、不做持久化
 * 上下游：
 *  - 上游（谁调用这里）：全仓通用（api/hooks/utils 各层排错输出）
 *  - 下游（本文件调用谁）：console.debug/info/warn/error
 */
/* eslint-disable no-console */
export const logger = {
  debug(...args: unknown[]) {
    console.debug('[squabble]', ...args);
  },
  info(...args: unknown[]) {
    console.info('[squabble]', ...args);
  },
  warn(...args: unknown[]) {
    console.warn('[squabble]', ...args);
  },
  error(...args: unknown[]) {
    console.error('[squabble]', ...args);
  },
};

export default logger;
