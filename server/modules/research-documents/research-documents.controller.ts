import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { NeedLogin } from '../../common/platform';
import { ResearchDocumentsService } from './research-documents.service';
import { parseReportRequest, reportIdSchema, reportIndexSchema, reportReferencesSchema, reportSourceSchema, revisionSchema } from './research-documents.rules';

@NeedLogin()
@Controller('api/research-documents')
export class ResearchDocumentsController {
  constructor(private readonly documents: ResearchDocumentsService) {}
  @Get() list(@Req() request: Request, @Query() query: unknown) {
    return this.documents.list(request.userContext.userId, parseReportRequest(reportIndexSchema, query));
  }
  @Post('import') importSource(@Req() request: Request, @Body() input: unknown) {
    return this.documents.importSource(request.userContext.userId, parseReportRequest(reportSourceSchema, input));
  }
  @Post('resolve') resolve(@Req() request: Request, @Body() input: unknown) {
    return this.documents.resolveReferences(request.userContext.userId, parseReportRequest(reportReferencesSchema, input));
  }
  @Get('versions/:id') view(@Req() request: Request, @Param('id') id: string) {
    return this.documents.view(request.userContext.userId, parseReportRequest(reportIdSchema, id));
  }
  @Post('versions/:id/drafts') createDraft(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.documents.createDraft(request.userContext.userId, parseReportRequest(reportIdSchema, id), parseReportRequest(revisionSchema, input));
  }
  @Patch('drafts/:id') updateDraft(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    const { expectedRevision, ...revision } = parseReportRequest(revisionSchema.extend({ expectedRevision: z.number().int().positive() }), input);
    return this.documents.updateDraft(request.userContext.userId, parseReportRequest(reportIdSchema, id), revision, expectedRevision);
  }
  @Post('drafts/:id/publish') publishDraft(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    const body = parseReportRequest(z.object({ expectedRevision: z.number().int().positive() }).strict(), input);
    return this.documents.publishDraft(request.userContext.userId, parseReportRequest(reportIdSchema, id), body.expectedRevision);
  }
  @Post('versions/:id/adopt') adopt(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    const body = parseReportRequest(z.object({ expectedAdoptedVersionId: reportIdSchema.nullable() }).strict(), input);
    return this.documents.adopt(request.userContext.userId, parseReportRequest(reportIdSchema, id), body.expectedAdoptedVersionId);
  }
  @Post('versions/:id/fork') fork(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    const body = parseReportRequest(z.object({ title: z.string().trim().min(1).max(300) }).strict(), input);
    return this.documents.fork(request.userContext.userId, parseReportRequest(reportIdSchema, id), body.title);
  }
  @Post('versions/:id/revoke') revoke(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    const body = parseReportRequest(z.object({ reason: z.string().trim().min(1).max(3000) }).strict(), input);
    return this.documents.revoke(request.userContext.userId, parseReportRequest(reportIdSchema, id), body.reason);
  }
}
