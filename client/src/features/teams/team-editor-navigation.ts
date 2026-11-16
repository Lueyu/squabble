export function teamEditorView(params: URLSearchParams, width: number): 'list' | 'canvas' {
  return params.get('view') ? params.get('view') === 'list' ? 'list' : 'canvas' : width < 700 ? 'list' : 'canvas';
}
export function withTeamEditorView(params: URLSearchParams, view: 'list' | 'canvas'): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('view', view);
  return next;
}
export function teamIssueDestination(issue: { code: string }): string {
  return /RELATION|REPORTING|SCOPE|MISSING_ROLE/.test(issue.code) ? 'relations' : 'organization';
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
