/**
 * view.module.ts — SPA 回退路由模块（不含任何业务逻辑）。
 *
 * 职责边界：
 *  - 只注册 ViewController，负责把前端单页应用（SPA）的 HTML 外壳返回给浏览器。
 *  - 不提供任何 Service，不做数据读写。
 * 上下游：
 *  - 上游：AppModule 注册本模块；被客户端浏览器直接访问。
 *  - 下游：仅调用 ViewController 的 index.hbs 模板渲染。
 * 关键约定：
 *  - 【必须最后注册】本模块必须作为 AppModule 中最后一个被 import 的模块：
 *    其兜底路由（'/' 与 '*'）要作为前端回退，绝不能拦截 /api 调用。
 *    server/app.module.ts 中 ViewModule 已位于 imports 数组末尾，调整顺序前务必确认。
 */
import { Module } from '@nestjs/common';
import { ViewController } from './view.controller';

/** View 模块定义：仅暴露 SPA 外壳控制器。 */
@Module({
  controllers: [ViewController],
  providers: [],
})
export class ViewModule {}
