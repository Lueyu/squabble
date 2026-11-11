import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { ToolCapabilitiesService } from './tool-capabilities.service';
@NeedLogin()
@Controller('api/tool-capabilities')
export class ToolCapabilitiesController {
  constructor(private readonly capabilities: ToolCapabilitiesService) {}
  @Get() list(@Req() req: Request) { return this.capabilities.list(req.userContext.userId); }
  @Post('refresh') refresh(@Req() req: Request) { return this.capabilities.refresh(req.userContext.userId); }
  @Post('activate') activate(@Req() req: Request, @Body() body: unknown) { return this.capabilities.activate(req.userContext.userId, body); }
  @Post(':packId/revoke') revoke(@Req() req: Request, @Param('packId') packId: string, @Body() body: unknown) {
    return this.capabilities.revoke(req.userContext.userId, packId, body);
  }
}
