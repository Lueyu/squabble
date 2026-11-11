import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { NeedLogin } from '../../common/platform';
import { computeRequestSchema } from './compute-policy';
import { ResearchComputeService } from './research-compute.service';

function id(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw new BadRequestException('COMPUTE_JOB_ID_INVALID');
  return result.data;
}
@NeedLogin()
@Controller('api/research-compute')
export class ResearchComputeController {
  constructor(private readonly compute: ResearchComputeService) {}
  @Get('configuration') configuration() { return this.compute.configuration(); }
  @Post('jobs') async create(@Req() request: Request, @Body() input: unknown) {
    const result = computeRequestSchema.safeParse(input);
    if (!result.success) throw new BadRequestException('COMPUTE_REQUEST_INVALID');
    return this.compute.run(request.userContext.userId, result.data);
  }
  @Get('jobs/:id') status(@Req() request: Request, @Param('id') jobId: string) {
    return this.compute.status(request.userContext.userId, id(jobId));
  }
  @Post('jobs/:id/cancel') cancel(@Req() request: Request, @Param('id') jobId: string) {
    return this.compute.cancel(request.userContext.userId, id(jobId));
  }
  @Post('jobs/:id/cleanup') cleanup(@Req() request: Request, @Param('id') jobId: string) {
    return this.compute.cleanup(request.userContext.userId, id(jobId));
  }
}
