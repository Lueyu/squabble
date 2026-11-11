import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { TelemetryService } from './telemetry.service';
import { TelemetryDiagnosticsService } from './telemetry-diagnostics.service';

@NeedLogin()
@Controller('api/telemetry')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService, private readonly diagnostics: TelemetryDiagnosticsService) {}
  @Get('workspace') workspace(@Req() request: Request, @Query() query: Record<string, unknown>) { return this.telemetry.workspace(request.userContext.userId, query); }
  @Get('runs/:id') detail(@Req() request: Request, @Param('id') id: string) { return this.telemetry.detail(request.userContext.userId, id); }
  @Get('runs/:id/diagnostics') diagnosticSnapshot(@Req() request: Request, @Param('id') id: string) { return this.diagnostics.read(request.userContext.userId, id); }
  @Put('runs/:id/feedback') feedback(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) { return this.telemetry.feedback(request.userContext.userId, id, body); }
}
