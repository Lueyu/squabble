import { BadRequestException, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { NeedLogin } from '../../common/platform';
import { RuntimeRecoveryService } from './runtime-recovery.service';

function runId(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException('RUNTIME_ID_INVALID');
  return parsed.data;
}

/** Owner-only projections contain no prompts, credentials, tool payloads or frozen private facts. */
@NeedLogin()
@Controller('api/research-runtime')
export class RuntimeReadController {
  constructor(private readonly recovery: RuntimeRecoveryService) {}

  @Get() list(@Req() request: Request, @Query('sessionId') sessionId: string) {
    return this.recovery.list(request.userContext.userId, runId(sessionId));
  }

  @Get(':id') status(@Req() request: Request, @Param('id') id: string) {
    return this.recovery.status(request.userContext.userId, runId(id));
  }
  @Post(':id/cancel') async cancel(@Req() request: Request, @Param('id') id: string) {
    await this.recovery.cancel(request.userContext.userId, runId(id));
    return this.recovery.status(request.userContext.userId, id);
  }
  @Post(':id/recover') async recover(@Req() request: Request, @Param('id') id: string) {
    await this.recovery.recover(request.userContext.userId, runId(id));
    return this.recovery.status(request.userContext.userId, id);
  }
  @Post(':id/close-unknown') async closeUnknown(@Req() request: Request, @Param('id') id: string) {
    await this.recovery.closeUnknown(request.userContext.userId, runId(id));
    return this.recovery.status(request.userContext.userId, id);
  }
}
