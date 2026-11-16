/**
 * @file server/common/i18n.ts
 * @description 服务端双语（zh/en）错误消息。
 *
 * 职责边界：只做"语言探测 + 双语选词"两件小事；不管理翻译词条表、
 * 不涉及前端 i18n。
 *
 * 上下游：import express 的 Request 类型；被各 controller/service 引用，
 * 用于按请求语言挑选拼装的错误文案。
 *
 * 关键约定：
 * - 语言判定顺序：优先读 X-Lang 请求头（由前端 axios 拦截器统一设置），
 *   其次读 Accept-Language；两者都判定不出时回退 zh（zh-CN）。
 */
import type { Request } from 'express';

/** 服务端支持的语言。 */
export type ServerLang = 'zh' | 'en';

/** 从请求中探测偏好语言。 */
export function detectLang(req: Request): ServerLang {
  // 显式语言头 X-Lang 优先：以 'en' / 'zh' 前缀判定（大小写敏感的startsWith，
  // 前端拦截器发送的即为小写值）。非字符串（如数组形式）则忽略。
  const explicit = req.headers['x-lang'];
  if (typeof explicit === 'string') {
    if (explicit.startsWith('en')) return 'en';
    if (explicit.startsWith('zh')) return 'zh';
  }
  // 退而求其次读 Accept-Language：仅当整体以 'en' 开头才视为英文，
  // q 值等更细的协商不做解析。都判不出时回退中文。
  const accept = req.headers['accept-language'];
  if (typeof accept === 'string' && accept.toLowerCase().startsWith('en')) {
    return 'en';
  }
  return 'zh';
}

/** 双语选词：按请求语言返回 zh 或 en 文案。 */
export function srvMsg(req: Request, zh: string, en: string): string {
  return detectLang(req) === 'en' ? en : zh;
}
