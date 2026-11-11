import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NeedLogin } from '../../common/platform';
import { ResearchArtifactsService } from './research-artifacts.service';

@NeedLogin()
@Controller('api/research-artifacts')
export class ResearchArtifactsController {
  constructor(private readonly artifacts: ResearchArtifactsService) {}
  @Get(':id/download') async download(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    const result = await this.artifacts.download(req.userContext.userId, id);
    res.setHeader('Content-Type', result.artifact.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `attachment; filename="${result.artifact.id}"`);
    res.send(result.data);
  }
}
