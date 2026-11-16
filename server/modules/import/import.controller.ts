/**
 * Import controller（导入控制器）。
 *
 * 职责边界：暴露 `/api/import` 下的三个端点——提交映射后的行（commit）、
 * 券商截图 OCR 提取（ocr/extract）、导入历史（history）；只做参数透传，
 * 校验与落库在 ImportService、上游调用在 OcrService。
 *
 * 上下游：import @nestjs/common、NeedLogin（逐路由鉴权）、ImportService 与
 * OcrService（本模块）、@shared/api.interface 的 DTO；由 import.module.ts
 * 注册。
 *
 * 关键约定：CSV 解析与列映射在客户端完成（papaparse），服务端只接收规范化
 * 行做校验+持久化；ocr/extract 用请求自带的大模型 Key（不落库）。
 */
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { ImportService } from './import.service';
import { OcrService } from './ocr.service';
import type { ImportCommitDto, OcrExtractDto } from '@shared/api.interface';

@Controller('api/import')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly ocr: OcrService,
  ) {}

  /** 从映射/提取出的行创建持仓（带来源标记）。 */
  @NeedLogin()
  @Post('commit')
  async commit(@Req() req: Request, @Body() dto: ImportCommitDto) {
    return this.imports.commit(req.userContext.userId, dto);
  }

  /** 用用户自己的大模型 Key 从券商截图中提取持仓行。 */
  @NeedLogin()
  @Post('ocr/extract')
  async ocrExtract(@Req() req: Request, @Body() dto: OcrExtractDto) {
    return this.ocr.extract(dto);
  }

  /** 当前用户最近的导入历史。 */
  @NeedLogin()
  @Get('history')
  async history(@Req() req: Request, @Query('limit') limit?: string) {
    return this.imports.history(req.userContext.userId, limit ? Number(limit) : undefined);
  }
}
