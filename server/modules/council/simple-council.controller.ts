import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards, NotFoundException, type CanActivate } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { SimpleCouncilService } from './simple-council.service';
import type { CreateResearchConversationInput, ResearchConversationMessageInput } from '../../../shared/simple-conversation.interface';
import type { ResearchRecoveryInput } from '../../../shared/research-execution.interface';
import type { NativeAgentConfiguration } from '../../../shared/local-agents.interface';

export class ResearchConversationEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.SQUABBLE_SIMPLE_EXPERIENCE !== 'true') throw new NotFoundException('Research conversations unavailable');
    return true;
  }
}
@UseGuards(ResearchConversationEnabledGuard)
@Controller('api/research-conversations')
export class ResearchConversationsController {
  constructor(private readonly conversations: SimpleCouncilService) {}
  @NeedLogin() @Get() async list(@Req() request: Request, @Query('search') search?: string) { return { items: await this.conversations.list(request.userContext.userId, search) }; }
  @NeedLogin() @Post() create(@Req() request: Request, @Body() input: CreateResearchConversationInput) { return this.conversations.create(request.userContext.userId, input); }
  @NeedLogin() @Get(':id') get(@Req() request: Request, @Param('id') id: string) { return this.conversations.get(request.userContext.userId, id); }
  @NeedLogin() @Post(':id/messages') message(@Req() request: Request, @Param('id') id: string, @Body() input: ResearchConversationMessageInput) { return this.conversations.addMessage(request.userContext.userId, id, input); }
  @NeedLogin() @Post(':id/recovery') recovery(@Req() request:Request,@Param('id') id:string,@Body() input:ResearchRecoveryInput){return this.conversations.recover(request.userContext.userId,id,input);}
  @NeedLogin() @Post(':id/stop') stop(@Req() request:Request,@Param('id') id:string){return this.conversations.stop(request.userContext.userId,id);}
  @NeedLogin() @Get(':id/members/:memberId/result') result(@Req() request:Request,@Param('id') id:string,@Param('memberId') memberId:string){return this.conversations.memberResult(request.userContext.userId,id,memberId);}
  @NeedLogin() @Patch(':id') rename(@Req() request: Request, @Param('id') id: string, @Body() input: { title: string; requestKey: string }) { return this.conversations.rename(request.userContext.userId, id, input); }
}

@NeedLogin()
@Controller('api/research-execution')
export class ResearchExecutionController {
  constructor(private readonly conversations:SimpleCouncilService){}
  @Get('readiness') readiness(@Req() request:Request){return this.conversations.executionReadiness(request.userContext.userId);}
  @Put(':id/configuration') configure(@Req() request:Request,@Param('id') id:string,@Body() input:NativeAgentConfiguration){return this.conversations.configureMember(request.userContext.userId,id,input);}
}
