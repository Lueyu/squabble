import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { InvestmentPolicyService } from './investment-policy.service';

@Controller('api/ai-investment')
export class InvestmentPolicyController {
  constructor(private readonly policies: InvestmentPolicyService) {}
  private async write<T>(req: Request, action: () => Promise<T>) { await this.policies.assertFeatureEnabled(req.userContext.userId); return action(); }
  @NeedLogin() @Get() overview(@Req() req: Request) { return this.policies.overview(req.userContext.userId); }
  @NeedLogin() @Post('preview') preview(@Req() req: Request, @Body() input: unknown) { return this.write(req, () => this.policies.preview(req.userContext.userId, input)); }
  @NeedLogin() @Post('start') start(@Req() req: Request, @Body() input: unknown) { return this.write(req, () => this.policies.start(req.userContext.userId, input)); }
  @NeedLogin() @Post('restart') restart(@Req() req: Request, @Body() input: unknown) { return this.write(req, () => this.policies.restart(req.userContext.userId, input)); }
  @NeedLogin() @Post('pause') pause(@Req() req: Request, @Body() input: unknown) { return this.policies.pause(req.userContext.userId, input); }
  @NeedLogin() @Post('resume') resume(@Req() req: Request, @Body() input: unknown) { return this.write(req, () => this.policies.resume(req.userContext.userId, input)); }
  @NeedLogin() @Post('constraints/propose') propose(@Req() req: Request, @Body() input: unknown) { return this.write(req, () => this.policies.propose(req.userContext.userId, input)); }
  @NeedLogin() @Post('constraints/:id/confirm') confirm(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.write(req, () => this.policies.confirm(req.userContext.userId, id, input)); }
  @NeedLogin() @Post('constraints/:id/revoke') revoke(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.write(req, () => this.policies.revoke(req.userContext.userId, id, input)); }
  @NeedLogin() @Post('legacy/:id/pause') legacyPause(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) { return this.policies.pauseLegacy(req.userContext.userId, id, input); }
  @NeedLogin() @Get('decisions/:id') decision(@Req() req: Request, @Param('id') id: string) { return this.policies.decision(req.userContext.userId, id); }
  @NeedLogin() @Get('history') history(@Req() req: Request) { return this.policies.history(req.userContext.userId); }
}
