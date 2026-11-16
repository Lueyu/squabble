/**
 * Import module（导入模块装配）。
 *
 * 职责边界：装配导入功能——注册 ImportController，提供 ImportService
 * （提交引擎）与 OcrService（OCR 代理）；HttpModule 供 OcrService 发起
 * 上游请求，QuoteModule 提供 ticker 市场检测能力。
 *
 * 上下游：import @nestjs/axios 的 HttpModule、QuoteModule（quote 模块）、
 * 本目录三件套；本模块被 app.module.ts 注册，exports ImportService。
 *
 * 关键约定：OCR 走用户自带的 OpenAI 兼容端点，服务端只做转发代理。
 */
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { QuoteModule } from '../quote/quote.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { OcrService } from './ocr.service';

@Module({
  imports: [HttpModule, QuoteModule],
  controllers: [ImportController],
  providers: [ImportService, OcrService],
  exports: [ImportService],
})
export class ImportModule {}
