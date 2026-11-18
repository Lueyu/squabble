import type { TeamRelation } from '@shared/team-workspace.interface';
import type { TeamGraphIssue } from './team-graph';

export function teamEditorView(params: URLSearchParams, width: number): 'list' | 'canvas' {
  const view = params.get('view');
  return view === 'canvas' || view === 'list' ? view : width < 700 ? 'list' : 'canvas';
}

export function opensTeamRelations(params: URLSearchParams): boolean {
  return params.get('panel') === 'relations' || (params.get('panel') === 'organization' && params.get('relations') === '1');
}
export function withTeamEditorView(params: URLSearchParams, view: 'list' | 'canvas'): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('view', view);
  return next;
}
export type TeamRelationView =
  | { kind: 'all' }
  | { kind: 'related'; roleId: string }
  | { kind: 'issues'; ids: string[] }
  | { kind: 'edit'; id: string }
  | { kind: 'add'; fromRoleId?: string; toRoleId?: string };

export function teamIssueDestination(issue: TeamGraphIssue, relations: TeamRelation[]): TeamRelationView | null {
  const id = relations.find(relation => issue.objectIds.includes(relation.id))?.id;
  if (id) return { kind: 'edit', id };
  if (issue.code === 'REPORTING_CYCLE') {
    const ids = relations.filter(relation => relation.kind === 'reports_to' &&
      issue.objectIds.includes(relation.fromRoleId) && issue.objectIds.includes(relation.toRoleId)).map(relation => relation.id);
    return { kind: 'issues', ids };
  }
  return null;
}

/** User-facing repair instructions; internal validator codes remain diagnostic details. */
export function teamIssueMessage(issue: { code: string; message: string }, zh: boolean): string {
  if (!zh) return issue.message;
  const messages: Record<string, string> = {
    ROLE_LIMIT: '岗位超过30个，请减少岗位', MISSING_DEPARTMENT: '所属部门不存在，请重新选择部门',
    DEPARTMENT_CYCLE: '部门层级形成循环，请调整上级部门', ROLE_CONFIGURATION: '请补全职责、预期交付和执行连接',
    MISSING_ROLE: '关系中的岗位不存在，请重选起点或终点', SELF_RELATION: '起点和终点不能是同一岗位',
    MISSING_SCOPE: '请补充汇报责任范围', DUPLICATE_RELATION: '关系与责任范围重复，请检查或移除',
    REPORTING_CYCLE: '汇报路径形成循环，请调整关系方向',
  };
  return messages[issue.code] ?? issue.message;
}
