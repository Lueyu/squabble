import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ResearchArchiveService } from './research-memory.archive';
import type { Request } from 'express';
import type { z } from 'zod';
import { NeedLogin } from '../../common/platform';
import { ResearchMemoryService } from './research-memory.service';
import { ResearchMonitorService } from './research-memory.monitor.service';
import { memoryIdSchema, memoryPreferencesSchema, memoryQuerySchema, memoryUpdateSchema, memoryInventoryQuerySchema,
  archiveImportSchema, archiveQuerySchema, thesisDeleteSchema, thesisUpdateSchema } from './research-memory.requests';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('MEMORY_INVALID_REQUEST');
  return result.data;
}

@NeedLogin()
@Controller('api/research-memory')
export class ResearchMemoryController {
  constructor(private readonly memory: ResearchMemoryService, private readonly archives: ResearchArchiveService, private readonly monitors: ResearchMonitorService) {}

  @Get('inventory') inventory(@Req() request: Request, @Query() query: unknown) {
    return this.memory.inventory(request.userContext.userId, parse(memoryInventoryQuerySchema, query));
  }

  @Get('theses/:id/monitors') monitorsForThesis(@Req() request: Request, @Param('id') id: string) {
    return this.monitors.view(request.userContext.userId, parse(memoryIdSchema, id));
  }
  @Post('theses/:id/monitors') writeMonitor(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.monitors.write(request.userContext.userId, parse(memoryIdSchema, id), body);
  }

  @Get() list(@Req() request: Request, @Query() query: unknown) {
    return this.memory.list(request.userContext.userId, parse(memoryQuerySchema, query));
  }
  @Get('archive-jobs') archiveJobs(@Req() request: Request, @Query() query: unknown) {
    return this.archives.list(request.userContext.userId, parse(archiveQuerySchema, query));
  }
  @Post('archive-jobs/import') importReports(@Req() request: Request, @Body() body: unknown) {
    return this.archives.importReports(request.userContext.userId, parse(archiveImportSchema, body));
  }
  @Post('archive-jobs/:id/retry') retryArchive(@Req() request: Request, @Param('id') id: string) {
    return this.archives.retry(request.userContext.userId, parse(memoryIdSchema, id));
  }
  @Get('memories/:id') memoryById(@Req() request: Request, @Param('id') id: string) {
    return this.memory.getMemory(request.userContext.userId, parse(memoryIdSchema, id));
  }
  @Get('preferences') preferences(@Req() request: Request) {
    return this.memory.getPreferences(request.userContext.userId);
  }
  @Get('recall') recall(@Req() request: Request, @Query() query: unknown) {
    return this.memory.recall(request.userContext.userId, parse(memoryQuerySchema, query));
  }
  @Put('preferences') updatePreferences(@Req() request: Request, @Body() body: unknown) {
    return this.memory.updatePreferences(request.userContext.userId, parse(memoryPreferencesSchema, body));
  }
  @Patch('memories/:id') updateMemory(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.memory.updateMemory(request.userContext.userId, parse(memoryIdSchema, id), parse(memoryUpdateSchema, body));
  }
  @Delete('memories/:id') deleteMemory(@Req() request: Request, @Param('id') id: string) {
    return this.memory.deleteMemory(request.userContext.userId, parse(memoryIdSchema, id));
  }
  @Get('theses/:id') thesis(@Req() request: Request, @Param('id') id: string) {
    return this.memory.getThesis(request.userContext.userId, parse(memoryIdSchema, id));
  }
  @Get('memories/:id/evidence') evidence(@Req() request: Request, @Param('id') id: string) {
    return this.memory.evidenceGraph(request.userContext.userId, parse(memoryIdSchema, id));
  }
  @Get('theses/:id/versions') versions(@Req() request: Request, @Param('id') id: string) {
    return this.memory.thesisVersions(request.userContext.userId, parse(memoryIdSchema, id));
  }
  @Patch('theses/:id') updateThesis(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.memory.updateThesis(request.userContext.userId, parse(memoryIdSchema, id), parse(thesisUpdateSchema, body));
  }
  @Delete('theses/:id') deleteThesis(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.memory.deleteThesis(request.userContext.userId, parse(memoryIdSchema, id), parse(thesisDeleteSchema, body).expectedVersion);
  }
}
