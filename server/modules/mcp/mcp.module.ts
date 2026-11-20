/**
 * mcp.module.ts — MCP 模块装配。
 *
 * 职责边界：
 *  - 注册 McpController（POST /mcp 协议端点 + /api/mcp/sessions 会话管理）与 McpService（JSON-RPC 分发 + 工具实现）。
 *  - 导入 PaperTradingModule/QuoteModule/ImportModule 供工具实现复用；导出 McpService。
 * 上下游：
 *  - 上游：应用根模块装配；外部 MCP 客户端经 POST /mcp 访问。
 *  - 下游：PaperTradingModule（下单/概览）、QuoteModule（行情）、ImportModule（导入持仓）。
 */
import { Module } from '@nestjs/common';
import { ImportModule } from '../import/import.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { QuoteModule } from '../quote/quote.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [PaperTradingModule, QuoteModule, ImportModule],
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
