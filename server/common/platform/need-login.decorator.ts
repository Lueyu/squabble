/**
 * NeedLogin 路由装饰器。
 *
 * 职责边界：只负责在 controller/handler 上打"需要登录"的元数据标记；
 * 不做任何校验逻辑。
 *
 * 上下游：import SetMetadata（@nestjs/common）；被全局鉴权 guard
 * （auth.guard.ts）读取 —— guard 校验 Bearer JWT 并在 handler 执行前把
 * `req.userContext` 挂到请求上。
 *
 * 关键约定：元数据键为 'sq:need-login'，值恒为 true；guard 用
 * getAllAndOverride 读取（方法级声明覆盖类级声明）。
 */
import { SetMetadata } from '@nestjs/common';

/** 全局鉴权 guard 扫描的元数据键。 */
export const NEED_LOGIN_KEY = 'sq:need-login';

/**
 * 在 controller 或路由上标注 `@NeedLogin()` 即要求有效会话。
 * handler 通过 `req.userContext.userId` 获取调用者身份。
 */
export const NeedLogin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(NEED_LOGIN_KEY, true) as MethodDecorator & ClassDecorator;
