import { useId, type ComponentProps } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AGENT_SPECIALTY_CATALOG } from '@shared/agent-specialty-catalog';
import type { TeamTemplate } from '@shared/team-templates';
import { agentRosterApi } from '@/api/agent-roster';
import { teamsApi } from '@/api/teams';
import { useUnlistedAgentProfiles } from '@/features/agent-roster/useUnlistedAgentProfiles';
import { TeamCanvasPreview } from './TeamCanvas';
import { relationLabel } from './team-graph';
import type { TeamRoleIdentity } from './team-flow-adapter';

function OrganizationReview(props: ComponentProps<typeof TeamCanvasPreview>) {
  const titleId = useId();
  const { zh } = props;
  return <section className="team-create-organization-preview" aria-labelledby={titleId}>
    <header className="team-create-organization-heading">
      <h3 id={titleId}>{zh ? '组织结构预览' : 'Organization preview'}</h3>
      <span className="team-muted team-small">{zh ? '只读' : 'Read-only'}</span>
    </header>
    <TeamCanvasPreview {...props} />
    <div className="team-create-organization-legend team-muted team-small">
      <span className="team-canvas-key">{relationLabel('reports_to', zh)}</span>
      <span className="team-canvas-key team-canvas-key-dashed">{relationLabel('reviews', zh)}</span>
    </div>
  </section>;
}

function localizedLabels(labels: Record<string, string>, zh: boolean): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).map(([id, label]) => {
    const [chinese, english] = label.split(' / ');
    return [id, zh ? chinese : english || chinese];
  }));
}

export function TeamTemplateOrganizationReview({ template, zh }: { template: TeamTemplate; zh: boolean }) {
  const friends = new Map(AGENT_SPECIALTY_CATALOG.map(friend => [friend.id, friend]));
  const staffing = new Map<string, TeamRoleIdentity>();
  for (const { roleId, recommendedTemplateId } of template.staffing) {
    const friend = friends.get(recommendedTemplateId);
    if (friend) staffing.set(roleId, { name: zh ? friend.name : friend.nameEn, avatar: friend.avatar });
  }
  return <OrganizationReview zh={zh} staffing={staffing} state={{
    config: template.config, layout: template.layout,
    display: {
      ...template.display,
      roleLabels: localizedLabels(template.display.roleLabels, zh),
      departmentLabels: localizedLabels(template.display.departmentLabels, zh),
    },
  }} />;
}

export function TeamCopyOrganizationReview({ teamId, versionId, zh }: { teamId?: string; versionId: string; zh: boolean }) {
  const source = useQuery({
    queryKey: ['teams', teamId, 'copy-preview', versionId],
    enabled: !!teamId,
    retry: false,
    queryFn: async () => {
      if (!teamId) throw new Error('Missing source team');
      const team = await teamsApi.detail(teamId);
      const version = team.publishedVersion?.id === versionId ? team.publishedVersion : await teamsApi.version(teamId, versionId);
      return { config: version.config, display: version.displaySnapshot, layout: { ...team.layout, collapsedDepartmentIds: [] } };
    },
  });
  const agentIds = source.data?.config.roles.map(role => role.agentId) ?? [];
  const roster = useQuery({
    queryKey: ['agent-roster'], queryFn: agentRosterApi.list, enabled: agentIds.some(Boolean), retry: false,
  });
  const { profiles: unlisted } = useUnlistedAgentProfiles(roster.data?.items, agentIds);
  if (teamId && source.isPending) return <p role="status" className="team-muted">{zh ? '正在读取已发布组织…' : 'Loading the published organization…'}</p>;
  if (!source.data) return <p role="status" className="team-muted">{zh ? '无法预览所选的已发布组织。' : 'The selected published organization is unavailable for preview.'}</p>;
  if (!source.data.config.roles.length && !source.data.config.departments.length) {
    return <p className="team-muted">{zh ? '所选版本没有岗位或部门。' : 'The selected version has no roles or departments.'}</p>;
  }
  return <OrganizationReview zh={zh} state={source.data} agents={[...(roster.data?.items ?? []), ...unlisted]} />;
}
