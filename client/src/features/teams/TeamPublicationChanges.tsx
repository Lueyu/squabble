import type { TeamDisplay, TeamExecutor, TeamSemanticConfig, TeamVersion } from '@shared/team-workspace.interface';
import { relationLabel } from './team-graph';
import './team-preview-review.css';

interface FieldChange { label: string; before: string; after: string }
interface ObjectChange { id: string; label: string; state: 'added' | 'removed' | 'changed'; fields: FieldChange[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${key}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
function readable(value: unknown, zh: boolean): string {
  if (value === undefined) return zh ? '不存在' : 'Not present';
  if (value === null) return zh ? '未指定' : 'Not set';
  if (value === '') return zh ? '空' : 'Empty';
  if (Array.isArray(value)) return value.length ? value.map(item => readable(item, zh)).join(' · ') : (zh ? '无' : 'None');
  if (typeof value === 'boolean') return value ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No');
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return entries.length ? entries.map(([key, child]) => `${key}: ${readable(child, zh)}`).join('; ') : (zh ? '无附加设置' : 'No additional settings');
  }
  return String(value);
}
function executorConnection(executor: TeamExecutor | null | undefined): string | null | undefined {
  if (executor === undefined) return undefined;
  if (executor === null) return null;
  return executor.executionMode === 'model' ? executor.connectionId : executor.localAgentId;
}
function executorModel(executor: TeamExecutor | null | undefined): string | null | undefined {
  if (executor === undefined) return undefined;
  if (executor === null) return null;
  return executor.executionMode === 'model' ? executor.model : typeof executor.settings.model === 'string' ? executor.settings.model : null;
}

/** Compare semantic identities and fields, independently of counts, geometry and display-only renames. */
export function teamPublicationDiff(previous: TeamVersion | null | undefined, config: TeamSemanticConfig, display: TeamDisplay, zh: boolean): ObjectChange[] {
  const result: ObjectChange[] = [];
  const beforeConfig = previous?.config;
  const beforeDisplay = previous?.displaySnapshot;
  const label = (id: string | null | undefined, kind: 'role' | 'department', old: boolean): string => {
    if (id === undefined) return readable(undefined, zh);
    if (id === null) return kind === 'department' ? (zh ? '画布根层' : 'Canvas root') : readable(null, zh);
    const names = old ? beforeDisplay : display;
    return (kind === 'role' ? names?.roleLabels[id] : names?.departmentLabels[id]) || id;
  };
  const fields = (): { values: FieldChange[]; add: (name: string, before: unknown, after: unknown, format?: (value: unknown, old: boolean) => string) => void } => {
    const values: FieldChange[] = [];
    return { values, add: (name, before, after, format) => { if (canonical(before) !== canonical(after)) values.push({ label: name, before: format ? format(before, true) : readable(before, zh), after: format ? format(after, false) : readable(after, zh) }); } };
  };
  const ids = (before: { id: string }[] | undefined, after: { id: string }[]): string[] => [...new Set([...(before ?? []).map(item => item.id), ...after.map(item => item.id)])];
  for (const id of ids(beforeConfig?.departments, config.departments)) {
    const before = beforeConfig?.departments.find(item => item.id === id); const after = config.departments.find(item => item.id === id); const change = fields();
    change.add(zh ? '父部门' : 'Parent department', before?.parentDepartmentId, after?.parentDepartmentId, (value, old) => label(value as string | null | undefined, 'department', old));
    change.add(zh ? '部门职责说明' : 'Department purpose', before?.purpose, after?.purpose);
    if (change.values.length) result.push({ id, label: `${zh ? '部门' : 'Department'} · ${label(id, 'department', !after)}`, state: !before ? 'added' : !after ? 'removed' : 'changed', fields: change.values });
  }
  for (const id of ids(beforeConfig?.roles, config.roles)) {
    const before = beforeConfig?.roles.find(item => item.id === id); const after = config.roles.find(item => item.id === id); const change = fields();
    change.add(zh ? '归属部门' : 'Department grouping', before?.departmentId, after?.departmentId, (value, old) => label(value as string | null | undefined, 'department', old));
    change.add(zh ? '参与状态' : 'Participation', before?.participation, after?.participation, value => value === undefined ? readable(undefined, zh) : value === 'enabled' ? (zh ? '已启用，可选入委托' : 'Enabled for selection') : (zh ? '待配置，不参与运行' : 'Placeholder, inactive'));
    change.add(zh ? '职责范围' : 'Responsibility', before?.responsibility, after?.responsibility);
    change.add(zh ? '预期交付' : 'Expected delivery', before?.expectedOutput, after?.expectedOutput);
    change.add(zh ? '执行器类型' : 'Executor type', before?.executor?.executionMode ?? (before ? null : undefined), after?.executor?.executionMode ?? (after ? null : undefined), value => value === 'model' ? (zh ? '模型连接' : 'API model connection') : value === 'local' ? (zh ? '原生助手' : 'Native assistant') : readable(value, zh));
    change.add(zh ? '执行连接标识' : 'Executor connection', executorConnection(before?.executor), executorConnection(after?.executor));
    change.add(zh ? '明确模型' : 'Explicit model', executorModel(before?.executor), executorModel(after?.executor));
    change.add(zh ? '模型档位' : 'Model tier', before?.executor?.executionMode === 'model' ? before.executor.tier ?? null : before ? null : undefined, after?.executor?.executionMode === 'model' ? after.executor.tier ?? null : after ? null : undefined);
    change.add(zh ? '执行器设置' : 'Executor settings', before?.executor?.settings ?? (before ? null : undefined), after?.executor?.settings ?? (after ? null : undefined));
    change.add(zh ? '工具范围' : 'Tool scope', before?.allowedToolIds, after?.allowedToolIds);
    change.add(zh ? '资料授权版本引用' : 'Source grant references', before?.sourceGrantIds, after?.sourceGrantIds);
    if (change.values.length) result.push({ id, label: `${zh ? '岗位' : 'Role'} · ${label(id, 'role', !after)}`, state: !before ? 'added' : !after ? 'removed' : 'changed', fields: change.values });
  }
  for (const id of ids(beforeConfig?.relations, config.relations)) {
    const before = beforeConfig?.relations.find(item => item.id === id); const after = config.relations.find(item => item.id === id); const change = fields();
    change.add(zh ? '起点岗位' : 'From role', before?.fromRoleId, after?.fromRoleId, (value, old) => label(value as string | undefined, 'role', old));
    change.add(zh ? '终点岗位' : 'To role', before?.toRoleId, after?.toRoleId, (value, old) => label(value as string | undefined, 'role', old));
    change.add(zh ? '关系类型' : 'Relation type', before?.kind, after?.kind, value => value === undefined ? readable(undefined, zh) : relationLabel(value as 'reports_to' | 'delegates_to' | 'reviews', zh));
    change.add(zh ? '汇报责任范围 / 协作交付' : 'Reporting scope / collaboration delivery', before?.responsibilityScope, after?.responsibilityScope);
    const relation = after ?? before!;
    if (change.values.length) result.push({ id, label: `${zh ? '关系' : 'Relation'} · ${label(relation.fromRoleId, 'role', !after)} → ${label(relation.toRoleId, 'role', !after)}`, state: !before ? 'added' : !after ? 'removed' : 'changed', fields: change.values });
  }
  const defaults = fields();
  defaults.add(zh ? '默认负责人建议' : 'Suggested final lead', beforeConfig?.defaults.leadRoleId, config.defaults.leadRoleId, (value, old) => label(value as string | null | undefined, 'role', old));
  defaults.add(zh ? '默认并行度' : 'Parallelism', beforeConfig?.defaults.parallelism, config.defaults.parallelism);
  if (defaults.values.length) result.push({ id: 'defaults', label: zh ? '委托默认建议' : 'Commission defaults', state: beforeConfig ? 'changed' : 'added', fields: defaults.values });
  return result;
}

export function TeamPublicationChanges({ previous, config, display, zh }: { previous: TeamVersion | null | undefined; config: TeamSemanticConfig; display: TeamDisplay; zh: boolean }) {
  const changes = teamPublicationDiff(previous, config, display, zh);
  return <section className="team-publication-changes" aria-label={zh ? '逐字段发布差异' : 'Publication field differences'}><h3>{zh ? '运行语义逐字段变化' : 'Execution configuration field changes'}</h3>
    {!changes.length && <p>{zh ? '没有运行语义变化。显示名称与布局不改变运行配置，服务器将保留相同的已发布配置版本。' : 'No execution configuration changes. Display names and layout do not alter execution; the server retains the same published configuration version.'}</p>}
    {changes.map(change => <article className="team-diff-object" key={change.id}><h4>{change.label}<span>{change.state === 'added' ? (zh ? '新增' : 'Added') : change.state === 'removed' ? (zh ? '删除' : 'Removed') : (zh ? '修改' : 'Changed')}</span></h4><dl>{change.fields.map(field => <div className="team-diff-field" key={field.label}><dt>{field.label}</dt><dd><span className="team-diff-value-label">{zh ? '变更前' : 'Before'}</span><span>{field.before}</span></dd><dd><span className="team-diff-value-label">{zh ? '变更后' : 'After'}</span><span>{field.after}</span></dd></div>)}</dl></article>)}
  </section>;
}
