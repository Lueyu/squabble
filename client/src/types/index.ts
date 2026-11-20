/**
 * @file types/index.ts
 * @description 共享类型的 barrel 再导出。
 *
 * 调用方统一从 `@client/src/types`（或相对路径 `../types`）导入，
 * 这样单个类型文件挪位置时不必改调用方。
 *
 * 职责边界：
 *  - 只做转发；不定义类型
 * 上下游：
 *  - 上游（谁调用这里）：需要共享类型的客户端模块
 *  - 下游（本文件调用谁）：./common
 */

// 再导出全部共享领域类型。
export * from './common';
