import { Module } from '@nestjs/common';
import { ToolBudgetService } from './tool-budget.service';
import { ToolConnectionsController } from './tool-connections.controller';
import { TOOL_CONNECTION_ADAPTERS, ToolConnectionsService } from './tool-connections.service';
import { ToolOAuthService } from './tool-oauth.service';
import { ToolTransportPolicy } from './tool-transport-policy';
import { McpClientAdapter } from './mcp-client.adapter';
import { ProviderHttp } from './providers/search-provider.contract';
import { TavilyAdapter } from './providers/tavily.adapter';
import { ExaAdapter } from './providers/exa.adapter';
import { FirecrawlAdapter } from './providers/firecrawl.adapter';
import { ComposioAdapter } from './providers/composio.adapter';

@Module({ controllers: [ToolConnectionsController], providers: [
  { provide: ToolTransportPolicy, useFactory: () => new ToolTransportPolicy() },
  { provide: TOOL_CONNECTION_ADAPTERS, inject: [ToolTransportPolicy], useFactory: (policy: ToolTransportPolicy) => {
    const http = new ProviderHttp(policy);
    return [new McpClientAdapter(policy), new TavilyAdapter(http), new ExaAdapter(http), new FirecrawlAdapter(http), new ComposioAdapter(http)];
  } }, ToolConnectionsService, ToolOAuthService, ToolBudgetService,
], exports: [ToolConnectionsService, TOOL_CONNECTION_ADAPTERS, ToolTransportPolicy, ToolBudgetService] })
export class ToolConnectionsModule {}
