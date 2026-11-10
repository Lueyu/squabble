import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NeedLogin } from '../../common/platform';
import { DataLibraryService } from './data-library.service';
import { DataFinancialService } from './data-financial.service';
import type { DataFinancialOperation, DataFinancialProvider, DataLibraryFileUpload, DataLibrarySourceCreate, DataLibrarySourceUpdate } from '../../../shared/data-library.interface';
@NeedLogin()
@Controller('api/data-library')
export class DataLibraryController {
  constructor(private readonly library: DataLibraryService, private readonly financial: DataFinancialService) {}
  @Get('sources') list(@Req() req: Request, @Query() query: Record<string, unknown>) { return this.library.list(req.userContext.userId, query); }
  @Post('sources') create(@Req() req: Request, @Body() body: DataLibrarySourceCreate) { return this.library.create(req.userContext.userId, body); }
  @Get('sources/:id') detail(@Req() req: Request, @Param('id') id: string) { return this.library.detail(req.userContext.userId, id); }
  @Patch('sources/:id') update(@Req() req: Request, @Param('id') id: string, @Body() body: DataLibrarySourceUpdate) { return this.library.update(req.userContext.userId, id, body); }
  @Delete('sources/:id') remove(@Req() req: Request, @Param('id') id: string) { return this.library.remove(req.userContext.userId, id); }
  @Post('sources/:id/sync') sync(@Req() req: Request, @Param('id') id: string) { return this.library.sync(req.userContext.userId, id); }
  @Get('sources/:id/versions/:versionId') version(@Req() req: Request, @Param('id') id: string, @Param('versionId') versionId: string) {
    return this.library.version(req.userContext.userId, id, versionId);
  }
  @Post('files') upload(@Req() req: Request, @Body() body: DataLibraryFileUpload) { return this.library.upload(req.userContext.userId, body); }
  @Get('sources/:id/file') async file(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    const file = await this.library.file(req.userContext.userId, id);
    res.setHeader('Content-Type', file.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `${file.image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/'/gu, '%27')}`); res.send(file.data);
  }
  @Get('jobs') jobs(@Req() req: Request, @Query() query: { sourceId?: string; offset?: number; limit?: number }) { return this.library.listJobs(req.userContext.userId, query); }
  @Post('search') search(@Req() req: Request, @Body() body: { query: string; limit?: number; sourceIds?: string[] }) { return this.library.search(req.userContext.userId, body); }
  @Get('financial') providers(@Req() req: Request) { return this.financial.list(req.userContext.userId); }
  @Put('financial/:provider') saveProvider(@Req() req: Request, @Param('provider') provider: string, @Body() body: { apiKey?: string; enabled?: boolean }) { return this.financial.save(req.userContext.userId, provider, body); }
  @Delete('financial/:provider') removeProvider(@Req() req: Request, @Param('provider') provider: string) { return this.financial.remove(req.userContext.userId, provider); }
  @Post('financial/:provider/test') testProvider(@Req() req: Request, @Param('provider') provider: string) { return this.financial.test(req.userContext.userId, provider); }
  @Post('financial/:provider/query') queryProvider(@Req() req: Request, @Param('provider') provider: DataFinancialProvider, @Body() body: { symbol: string; operation: DataFinancialOperation }) {
    return this.financial.query(req.userContext.userId, { ...body, provider });
  }
}
