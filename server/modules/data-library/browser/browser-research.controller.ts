import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../../common/platform';
import { inspectBrowserEnvironment } from './browser-environment';

/** Read-only availability only. Browser actions are internal runtime tools, never a global MCP HTTP API. */
@NeedLogin()
@Controller('api/browser-research')
export class BrowserResearchController {
  @Get('availability') async availability(@Req() request: Request) {
    if (!request.userContext.userId) throw new Error('OWNER_REQUIRED');
    const local = await inspectBrowserEnvironment();
    return { local: { available: local.available, reason: local.reason ?? null },
      playwrightMcp: { available: false, reason: 'BROWSER_MCP_DEPLOYMENT_UNVERIFIED' },
      browserbase: { available: false, reason: 'BROWSERBASE_NAVIGATION_EGRESS_UNVERIFIED' } };
  }
}
