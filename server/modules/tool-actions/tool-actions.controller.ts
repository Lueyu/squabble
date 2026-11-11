import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { ToolActionsService } from './tool-actions.service';

/** Confirm only saves approval. The run resumes through its original owner/session recovery entry. */
@NeedLogin()
@Controller('api/tool-actions')
export class ToolActionsController {
  constructor(private readonly actions: ToolActionsService) {}
  @Get() list(@Req() request: Request, @Query('runId') runId?: string) { return this.actions.list(request.userContext.userId, runId); }
  @Get(':id') detail(@Req() request: Request, @Param('id') id: string) { return this.actions.detail(request.userContext.userId, id); }
  @Post(':id/confirm') confirm(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) { return this.actions.confirm(request.userContext.userId, id, body); }
  @Post(':id/reject') reject(@Req() request: Request, @Param('id') id: string) { return this.actions.reject(request.userContext.userId, id); }
  @Put(':id/preview') edit(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) { return this.actions.edit(request.userContext.userId, id, body); }
}
