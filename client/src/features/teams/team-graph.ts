import type { TeamDepartment, TeamDisplay, TeamLayout, TeamRelation, TeamRole, TeamSemanticConfig, TeamVersion } from '@shared/team-workspace.interface';

export interface TeamEditorState { config: TeamSemanticConfig; display: TeamDisplay; layout: TeamLayout }
export interface TeamGraphIssue { code: string; objectIds: string[]; message: string }
export interface TeamHistory { past: TeamEditorState[]; present: TeamEditorState; future: TeamEditorState[] }
export const MAX_TEAM_ROLES = 30;

export function emptyTeamState(name = ''): TeamEditorState {
  return { config: { schemaVersion: 1, departments: [], roles: [], relations: [], defaults: { leadRoleId: null, parallelism: 1 } },
    display: { name, avatar: null, departmentLabels: {}, roleLabels: {} },
    layout: { schemaVersion: 1, positions: {}, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } } };
}
export function createTeamHistory(present: TeamEditorState): TeamHistory { return { past: [], present, future: [] }; }
export function commitTeamEdit(history: TeamHistory, next: TeamEditorState): TeamHistory {
  if (JSON.stringify(next) === JSON.stringify(history.present)) return history;
  return { past: [...history.past.slice(-79), history.present], present: next, future: [] };
}
export function undoTeamEdit(history: TeamHistory): TeamHistory {
  if (!history.past.length) return history;
  return { past: history.past.slice(0, -1), present: history.past[history.past.length - 1], future: [history.present, ...history.future] };
}
export function redoTeamEdit(history: TeamHistory): TeamHistory {
  if (!history.future.length) return history;
  return { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1) };
}
export function departmentDescendants(config: TeamSemanticConfig, id: string): string[] {
  const found = new Set<string>();
  const visit = (parent: string): void => { config.departments.filter(d => d.parentDepartmentId === parent).forEach(d => { if (!found.has(d.id)) { found.add(d.id); visit(d.id); } }); };
  visit(id); return [...found];
}
export function objectParent(config: TeamSemanticConfig, id: string): string | null {
  return config.departments.find(d => d.id === id)?.parentDepartmentId ?? config.roles.find(r => r.id === id)?.departmentId ?? null;
}
/** Stored coordinates are relative to the semantic parent; reparenting preserves screen location. */
export function absolutePosition(state: TeamEditorState, id: string): { x: number; y: number } {
  const seen = new Set<string>(); let current: string | null = id; let x = 0; let y = 0;
  while (current && !seen.has(current)) { seen.add(current); const p = state.layout.positions[current]; x += p?.x ?? 0; y += p?.y ?? 0; current = objectParent(state.config, current); }
  return { x, y };
}
export function moveTeamObjects(state: TeamEditorState, ids: string[], target: string | null): TeamEditorState {
  if (target && !state.config.departments.some(d => d.id === target)) throw new Error('Unknown department');
  for (const id of ids) if (id === target || departmentDescendants(state.config, id).includes(target ?? '')) throw new Error('A department cannot enter itself or its descendant.');
  const selected = ids.filter(id => { let parent = objectParent(state.config, id); const seen = new Set<string>(); while (parent && !seen.has(parent)) { if (ids.includes(parent)) return false; seen.add(parent); parent = objectParent(state.config, parent); } return true; });
  const positions = { ...state.layout.positions }; const origin = target ? absolutePosition(state, target) : { x: 0, y: 0 };
  selected.forEach(id => { const p = absolutePosition(state, id); positions[id] = { ...positions[id], x: p.x - origin.x, y: p.y - origin.y }; });
  return { ...state, config: { ...state.config, departments: state.config.departments.map(d => selected.includes(d.id) ? { ...d, parentDepartmentId: target } : d), roles: state.config.roles.map(r => selected.includes(r.id) ? { ...r, departmentId: target } : r) }, layout: { ...state.layout, positions } };
}
export function dissolveDepartment(state: TeamEditorState, id: string, deleteContents: boolean): TeamEditorState {
  if (deleteContents) return deleteTeamObjects(state, [id]);
  const parent = state.config.departments.find(d => d.id === id)?.parentDepartmentId ?? null;
  const children = [...state.config.departments.filter(d => d.parentDepartmentId === id).map(d => d.id), ...state.config.roles.filter(r => r.departmentId === id).map(r => r.id)];
  return deleteTeamObjects(moveTeamObjects(state, children, parent), [id]);
}
export function deleteTeamObjects(state: TeamEditorState, ids: string[]): TeamEditorState {
  const remove = new Set(ids); ids.forEach(id => departmentDescendants(state.config, id).forEach(child => remove.add(child)));
  state.config.roles.forEach(r => { if (r.departmentId && remove.has(r.departmentId)) remove.add(r.id); });
  const filterLabels = (labels: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(labels).filter(([id]) => !remove.has(id)));
  return { config: { ...state.config, departments: state.config.departments.filter(d => !remove.has(d.id)), roles: state.config.roles.filter(r => !remove.has(r.id)), relations: state.config.relations.filter(r => !remove.has(r.id) && !remove.has(r.fromRoleId) && !remove.has(r.toRoleId)), defaults: { ...state.config.defaults, leadRoleId: remove.has(state.config.defaults.leadRoleId ?? '') ? null : state.config.defaults.leadRoleId } },
    display: { ...state.display, departmentLabels: filterLabels(state.display.departmentLabels), roleLabels: filterLabels(state.display.roleLabels) },
    layout: { ...state.layout, positions: Object.fromEntries(Object.entries(state.layout.positions).filter(([id]) => !remove.has(id))), collapsedDepartmentIds: state.layout.collapsedDepartmentIds.filter(id => !remove.has(id)) } };
}
export function addTeamObject(state: TeamEditorState, kind: 'role' | 'department', parent: string | null, label: string, id = crypto.randomUUID()): TeamEditorState {
  if (kind === 'role' && state.config.roles.length >= MAX_TEAM_ROLES) throw new Error('A team can contain at most 30 roles.');
  const position = { x: parent ? 32 : 100 + state.config.roles.length * 24, y: parent ? 80 : 100 + state.config.roles.length * 24, ...(kind === 'department' ? { width: 600, height: 400 } : {}) };
  const role: TeamRole = { id, departmentId: parent, participation: 'placeholder', responsibility: '', expectedOutput: '', executor: null, allowedToolIds: [], sourceGrantIds: [] };
  const department: TeamDepartment = { id, parentDepartmentId: parent, purpose: '' };
  return { config: { ...state.config, departments: kind === 'department' ? [...state.config.departments, department] : state.config.departments, roles: kind === 'role' ? [...state.config.roles, role] : state.config.roles },
    display: { ...state.display, [kind === 'department' ? 'departmentLabels' : 'roleLabels']: { ...(kind === 'department' ? state.display.departmentLabels : state.display.roleLabels), [id]: label } }, layout: { ...state.layout, positions: { ...state.layout.positions, [id]: position } } };
}
export function duplicateTeamObjects(state: TeamEditorState, ids: string[], suffix: string): TeamEditorState {
  const selected = new Set(ids); ids.forEach(id => departmentDescendants(state.config, id).forEach(child => selected.add(child)));
  state.config.roles.forEach(r => { if (selected.has(r.departmentId ?? '')) selected.add(r.id); });
  const roles = state.config.roles.filter(r => selected.has(r.id));
  if (roles.length + state.config.roles.length > MAX_TEAM_ROLES) throw new Error('Copy would exceed the 30 role limit. No objects were copied.');
  const mapping = new Map([...selected].map(id => [id, crypto.randomUUID()]));
  const departments = state.config.departments.filter(d => selected.has(d.id));
  const relations = state.config.relations.filter(r => selected.has(r.fromRoleId) && selected.has(r.toRoleId));
  const positions = { ...state.layout.positions }; const departmentLabels = { ...state.display.departmentLabels }; const roleLabels = { ...state.display.roleLabels };
  [...departments, ...roles].forEach(item => { const id = mapping.get(item.id)!; const parent = objectParent(state.config, item.id); const p = state.layout.positions[item.id] ?? { x: 0, y: 0 }; positions[id] = { ...p, x: p.x + (selected.has(parent ?? '') ? 0 : 40), y: p.y + (selected.has(parent ?? '') ? 0 : 40) }; if ('purpose' in item) departmentLabels[id] = `${departmentLabels[item.id] ?? ''} ${suffix}`; else roleLabels[id] = `${roleLabels[item.id] ?? ''} ${suffix}`; });
  return { config: { ...state.config, departments: [...state.config.departments, ...departments.map(d => ({ ...d, id: mapping.get(d.id)!, parentDepartmentId: mapping.get(d.parentDepartmentId ?? '') ?? d.parentDepartmentId }))], roles: [...state.config.roles, ...roles.map(r => ({ ...r, id: mapping.get(r.id)!, departmentId: mapping.get(r.departmentId ?? '') ?? r.departmentId, sourceGrantIds: [], allowedToolIds: [...r.allowedToolIds] }))], relations: [...state.config.relations, ...relations.map(r => ({ ...r, id: crypto.randomUUID(), fromRoleId: mapping.get(r.fromRoleId)!, toRoleId: mapping.get(r.toRoleId)! }))] }, display: { ...state.display, departmentLabels, roleLabels }, layout: { ...state.layout, positions } };
}
export function restoreTeamVersion(state: TeamEditorState, version: TeamVersion): TeamEditorState {
  const objects = [...version.config.departments, ...version.config.roles]; const ids = new Set(objects.map(object => object.id));
  const positions = Object.fromEntries(objects.map((object, index) => [object.id, state.layout.positions[object.id] ?? { x: 40 + (index % 3) * 250, y: 80 + Math.floor(index / 3) * 180 }]));
  return { config: version.config, display: { ...version.displaySnapshot, name: state.display.name, avatar: state.display.avatar }, layout: { ...state.layout, positions, collapsedDepartmentIds: state.layout.collapsedDepartmentIds.filter(id => ids.has(id)) } };
}
export function validateTeamGraph(config: TeamSemanticConfig): TeamGraphIssue[] {
  const issues: TeamGraphIssue[] = []; const roles = new Set(config.roles.map(r => r.id)); const departments = new Set(config.departments.map(d => d.id)); const signatures = new Set<string>();
  const add = (code: string, objectIds: string[], message: string): void => { if (!issues.some(i => i.code === code && i.objectIds.join() === objectIds.join())) issues.push({ code, objectIds, message }); };
  if (config.roles.length > MAX_TEAM_ROLES) add('ROLE_LIMIT', [], 'The team exceeds 30 roles.');
  config.departments.forEach(d => { if (d.parentDepartmentId && !departments.has(d.parentDepartmentId)) add('MISSING_DEPARTMENT', [d.id], 'Parent department is missing.'); let current: string | null = d.parentDepartmentId; const seen = new Set([d.id]); while (current) { if (seen.has(current)) { add('DEPARTMENT_CYCLE', [d.id], 'Department nesting contains a cycle.'); break; } seen.add(current); current = config.departments.find(item => item.id === current)?.parentDepartmentId ?? null; } });
  config.roles.forEach(r => { if (r.departmentId && !departments.has(r.departmentId)) add('MISSING_DEPARTMENT', [r.id], 'Role department is missing.'); if (r.participation === 'enabled' && (!r.responsibility.trim() || !r.expectedOutput.trim() || !r.executor)) add('ROLE_CONFIGURATION', [r.id], 'An enabled role needs responsibility, expected delivery and a connection.'); });
  config.relations.forEach(r => { if (!roles.has(r.fromRoleId) || !roles.has(r.toRoleId)) add('MISSING_ROLE', [r.id], 'Relation refers to a missing role.'); if (r.fromRoleId === r.toRoleId) add('SELF_RELATION', [r.id, r.fromRoleId], 'A role cannot report or collaborate with itself.'); if (r.kind === 'reports_to' && !r.responsibilityScope.trim()) add('MISSING_SCOPE', [r.id], 'Reporting responsibility scope is required.'); const signature = `${r.kind}:${r.fromRoleId}:${r.toRoleId}:${r.responsibilityScope.trim()}`; if (signatures.has(signature)) add('DUPLICATE_RELATION', [r.id], 'This relation and responsibility scope already exist.'); signatures.add(signature); });
  const visited = new Set<string>(); const stack: string[] = [];
  const visit = (id: string): void => { if (stack.includes(id)) { add('REPORTING_CYCLE', stack.slice(stack.indexOf(id)), 'Reporting responsibilities contain a cycle.'); return; } if (visited.has(id)) return; stack.push(id); config.relations.filter(r => r.kind === 'reports_to' && r.fromRoleId === id).forEach(r => visit(r.toRoleId)); stack.pop(); visited.add(id); };
  config.roles.forEach(r => visit(r.id)); return issues;
}
export function roleLabel(state: TeamEditorState, id: string): string { return state.display.roleLabels[id] || id; }
export function relationLabel(kind: TeamRelation['kind'], zh: boolean): string { return ({ reports_to: zh ? '汇报' : 'Reports to', delegates_to: zh ? '委托协作' : 'Delegates to', reviews: zh ? '复核协作' : 'Reviews' })[kind]; }
