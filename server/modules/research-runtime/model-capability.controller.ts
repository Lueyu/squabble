import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { NeedLogin } from '../../common/platform';
import { ModelCapabilityService } from './model-capability.service';

@NeedLogin()
@Controller('api/model-tool-capabilities')
export class ModelCapabilityController {
  constructor(private readonly capabilities: ModelCapabilityService) {}
  @Get() list(@Req() req: Request) { return this.capabilities.list(req.userContext.userId); }
  @Get('drivers') drivers(@Req() req: Request) { return this.capabilities.drivers(req.userContext.userId); }
  @Post('driver') driver(@Req() req: Request, @Body() body: unknown) { return this.capabilities.setDriver(req.userContext.userId, body); }
  @Post('probe') probe(@Req() req: Request, @Body() body: unknown) { return this.capabilities.probe(req.userContext.userId, body); }
  @Post('disable') disable(@Req() req: Request, @Body() body: unknown) {
    const input = z.strictObject({ connectionId: z.union([z.uuid(), z.literal('')]) }).safeParse(body);
    if (!input.success) throw new BadRequestException('MODEL_CONNECTION_INVALID');
    return this.capabilities.disable(req.userContext.userId, input.data.connectionId);
  }
}
