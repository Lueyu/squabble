import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { ToolConnectionsService } from './tool-connections.service';
import { ToolOAuthService } from './tool-oauth.service';

/** Configuration and discovery only. There is intentionally no general tools/call HTTP proxy. */
@NeedLogin()
@Controller('api/tool-connections')
export class ToolConnectionsController {
  constructor(private readonly connections: ToolConnectionsService, private readonly oauth: ToolOAuthService) {}
  @Get() list(@Req() request: Request) { return this.connections.list(request.userContext.userId); }
  @Post() create(@Req() request: Request, @Body() body: unknown) { return this.connections.create(request.userContext.userId, body); }
  @Post('oauth/callback') callback(@Req() request: Request, @Body() body: unknown) {
    return this.oauth.complete(request.userContext.userId, body);
  }
  @Post('jobs/:id/status') status(@Req() request: Request, @Param('id') id: string) { return this.connections.remoteJob(request.userContext.userId, id); }
  @Post('jobs/:id/cancel') cancel(@Req() request: Request, @Param('id') id: string) { return this.connections.remoteJob(request.userContext.userId, id, true); }
  @Get(':id') detail(@Req() request: Request, @Param('id') id: string) { return this.connections.detail(request.userContext.userId, id); }
  @Get(':id/catalog') catalog(@Req() request: Request, @Param('id') id: string) { return this.connections.catalog(request.userContext.userId, id); }
  @Put(':id/credential') credential(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.connections.setCredential(request.userContext.userId, id, body);
  }
  @Post(':id/discover') discover(@Req() request: Request, @Param('id') id: string) { return this.connections.discover(request.userContext.userId, id); }
  @Post(':id/enable') enable(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.connections.enable(request.userContext.userId, id, body);
  }
  @Post(':id/oauth') authorize(@Req() request: Request, @Param('id') id: string) { return this.oauth.begin(request.userContext.userId, id); }
  @Post(':id/composio/authorize') authorizeApp(@Req() request: Request, @Param('id') id: string) { return this.connections.authorizeComposio(request.userContext.userId, id); }
  @Post(':id/composio/complete') completeApp(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) { return this.connections.completeComposio(request.userContext.userId, id, body); }
  @Delete(':id') disconnect(@Req() request: Request, @Param('id') id: string) { return this.connections.disconnect(request.userContext.userId, id); }
}
