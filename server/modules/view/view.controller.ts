/**
 * view.controller.ts — SPA 回退控制器（服务器渲染 HTML 外壳）。
 *
 * 职责边界：
 *  - 只负责渲染前端单页应用的 index.hbs 外壳并注入平台数据，无任何业务逻辑。
 *  - 不提供 /api 数据接口。
 * 上下游：
 *  - 上游：客户端浏览器直接访问根路径或任意未匹配路径；
 *    AppModule 中必须最后注册本控制器所在模块（ViewModule）。
 *  - 下游：NestJS Render 管线渲染 index.hbs 模板。
 * 关键约定：
 *  - 【必须最后注册】兜底路由捕获根路径 '/' 与所有未匹配路径 '*'，
 *    若注册早于其他模块会遮蔽 /api 路由，因此 ViewModule 必须是 AppModule
 *    中最后一个 import 的模块。
 *  - 返回值中的 __platform__ 字段（序列化后的平台信息 JSON）是客户端
 *    启动时读取平台数据的唯一入口，不可移除。
 */
import { Controller, Get, Render, Req } from '@nestjs/common';
import type { Request } from 'express';

/**
 * 渲染 SPA 入口页。无业务逻辑，纯视图路由。
 */
@Controller()
export class ViewController {
  /**
   * 渲染 index 视图，覆盖应用根路径与所有非 API 的回退路径。
   *
   * @param req Express 请求对象；其上的 `__platform_data__` 由平台中间件注入
   * @returns 模板变量，含序列化后的平台信息
   */
  @Get(['/', '*'])
  @Render('index')
  async render(@Req() req: Request): Promise<{ __platform__: string }> {
    // 自定义渲染参数可在此处附加。
    const platformData = req.__platform_data__ ?? {};
    return {
      // 客户端启动时读取平台信息依赖此字段；不可移除。
      __platform__: JSON.stringify(platformData),
    };
  }
}
