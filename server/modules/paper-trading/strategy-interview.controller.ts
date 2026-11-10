import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { StrategyInterviewService } from './strategy-interview.service';

@Controller('api/strategy-interviews')
export class StrategyInterviewController {
  constructor(private readonly service: StrategyInterviewService) {}
  @NeedLogin() @Get()
  list(@Req() req: Request, @Query('accountId') accountId?: string) { return this.service.list(req.userContext.userId, accountId); }
  @NeedLogin() @Post()
  create(@Req() req: Request, @Body() input: unknown) { return this.service.create(req.userContext.userId, input); }
  @NeedLogin() @Get(':id')
  get(@Req() req: Request, @Param('id') id: string) { return this.service.get(req.userContext.userId, id); }
  @NeedLogin() @Get(':id/review')
  review(@Req() req: Request, @Param('id') id: string) { return this.service.review(req.userContext.userId, id); }
  @NeedLogin() @Post(':id/messages')
  answer(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.service.answer(req.userContext.userId, id, input); }
  @NeedLogin() @Post(':id/accept')
  accept(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.service.accept(req.userContext.userId, id, input); }
  @NeedLogin() @Post(':id/preview')
  preview(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.service.preview(req.userContext.userId, id, input); }
}
