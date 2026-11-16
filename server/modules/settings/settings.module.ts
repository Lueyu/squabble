/**
 * Settings module（集成设置模块）。
 *
 * 职责边界：装配集成设置面——SettingsService（LLM/Finnhub 密钥加密存
 * 取）、ModelConnectionsService（附加模型连接）、SettingsController 与
 * ModelConnectionsController 两个控制器，并把 LlmService 提供为本模块
 * provider。声明为 @Global：其他模块无需 import 即可注入 SettingsService。
 *
 * 上下游：import QuoteModule（行情探测）；provider 里直接实例化
 * LlmService（multi-agent 的 LLM 客户端，依赖 SettingsService 解析配置）；
 * exports 仅 SettingsService——LlmService 不外泄，调用方经
 * SettingsService 走配置。
 *
 * 关键约定：@Global 导出意味着几乎所有模块都拿得到 SettingsService；
 * ModelConnectionsService 为 @Optional 注入位置提供了 provider。
 */
import { Global, Module } from '@nestjs/common';
import { LlmService } from '../multi-agent/llm.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { QuoteModule } from '../quote/quote.module';
import { ModelConnectionsService } from './model-connections.service';
import { ModelConnectionsController } from './model-connections.controller';

@Global()
@Module({
  imports: [QuoteModule],
  controllers: [SettingsController, ModelConnectionsController],
  providers: [SettingsService, LlmService, ModelConnectionsService],
  exports: [SettingsService],
})
export class SettingsModule {}
