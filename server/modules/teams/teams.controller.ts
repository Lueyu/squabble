import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, HttpCode } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { TeamsService } from './teams.service';
import { TeamVersionService } from './team-version.service';
import { TeamCommissionService } from './team-commission.service';
import { TeamDecisionService } from './team-decision.service';
import { TeamSourceAccessService } from './team-source-access.service';
import { teamError } from './team-contract';
function body(req: Request, input: unknown): unknown {
    const header = req.get('x-request-key') ?? req.get('idempotency-key');
    if (header && (!input || typeof input !== 'object' || !('requestKey' in input) || input.requestKey !== header))
        teamError('TEAM_INVALID_INPUT', 'Request key header and body disagree');
    return input;
}
@Controller('api/teams')
export class TeamsController {
    constructor(private readonly teams: TeamsService, private readonly versions: TeamVersionService, private readonly commissions: TeamCommissionService, private readonly decisions: TeamDecisionService, private readonly sources: TeamSourceAccessService) { }
    @NeedLogin()
    @Get()
    list(
    @Req()
    req: Request,
    @Query()
    query: unknown) { return this.teams.list(req.userContext.userId, query); }
    @NeedLogin()
    @Post()
    create(
    @Req()
    req: Request,
    @Body()
    input: unknown) { return this.teams.create(req.userContext.userId, body(req, input)); }
    @NeedLogin()
    @Get(':id')
    detail(
    @Req()
    req: Request,
    @Param('id')
    id: string) { return this.teams.detail(req.userContext.userId, id); }
    @NeedLogin()
    @Patch(':id/display')
    display(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.teams.save(req.userContext.userId, id, 'display', body(req, input)); }
    @NeedLogin()
    @Put(':id/layout')
    layout(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.teams.save(req.userContext.userId, id, 'layout', body(req, input)); }
    @NeedLogin()
    @Put(':id/draft')
    draft(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.teams.save(req.userContext.userId, id, 'draft', body(req, input)); }
    @NeedLogin()
    @Get(':id/versions')
    history(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Query()
    query: unknown) { return this.teams.versions(req.userContext.userId, id, undefined, query); }
    @NeedLogin()
    @Get(':id/versions/:vid')
    version(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('vid')
    vid: string) { return this.teams.versions(req.userContext.userId, id, vid); }
    @NeedLogin()
    @Post(':id/connection-check')
    @HttpCode(200)
    check(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.versions.check(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/publish-preview')
    @HttpCode(200)
    publishPreview(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.versions.publishPreview(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/publish')
    @HttpCode(200)
    publish(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.versions.publish(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/binding-preview')
    @HttpCode(200)
    bindingPreview(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.versions.bindingPreview(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/binding')
    @HttpCode(200)
    binding(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.versions.binding(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/archive-preview')
    @HttpCode(200)
    archivePreview(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.versions.archivePreview(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/archive')
    @HttpCode(200)
    archive(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.versions.archive(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/commission-preview')
    @HttpCode(200)
    commissionPreview(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.commissions.preview(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/commissions')
    @HttpCode(202)
    commission(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.commissions.create(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Get(':id/commissions')
    commissionList(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Query()
    query: unknown) { return this.commissions.list(req.userContext.userId, id, query); }
    @NeedLogin()
    @Get(':id/commissions/:cid')
    commissionDetail(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('cid')
    cid: string) { return this.commissions.detail(req.userContext.userId, id, cid); }
    @NeedLogin()
    @Post(':id/commissions/:cid/cancel')
    @HttpCode(202)
    cancel(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('cid')
    cid: string,
    @Body()
    input: unknown) { return this.commissions.control(req.userContext.userId, id, cid, 'cancel', body(req, input)); }
    @NeedLogin()
    @Post(':id/commissions/:cid/recover')
    @HttpCode(202)
    recover(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('cid')
    cid: string,
    @Body()
    input: unknown) { return this.commissions.control(req.userContext.userId, id, cid, 'recover', body(req, input)); }
    @NeedLogin()
    @Patch(':id/commissions/:cid/budget-limit')
    budget(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('cid')
    cid: string,
    @Body()
    input: unknown) { return this.commissions.control(req.userContext.userId, id, cid, 'budget-limit', body(req, input)); }
    @NeedLogin()
    @Get(':id/decisions')
    decisionList(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Query()
    query: unknown) { return this.decisions.list(req.userContext.userId, id, query); }
    @NeedLogin()
    @Post(':id/decisions')
    decision(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.decisions.create(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Get(':id/source-grants')
    sourceList(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Query()
    query: unknown) { return this.sources.list(req.userContext.userId, id, query); }
    @NeedLogin()
    @Post(':id/source-grants')
    source(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Body()
    input: unknown) { return this.sources.grant(req.userContext.userId, id, body(req, input)); }
    @NeedLogin()
    @Post(':id/source-grants/:gid/revoke')
    @HttpCode(200)
    revoke(
    @Req()
    req: Request,
    @Param('id')
    id: string,
    @Param('gid')
    gid: string,
    @Body()
    input: unknown) { return this.sources.revoke(req.userContext.userId, id, gid, body(req, input)); }
}
