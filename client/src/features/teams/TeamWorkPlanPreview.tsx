import { useRef, useState } from 'react';
import { ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { TeamSemanticConfig, TeamWorkPlanPreviewResult } from '@shared/team-workspace.interface';
import type { TeamBlueprintTaskKind } from '@shared/team-work-blueprint.interface';
import { teamsApi } from '@/api/teams';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { friendlyError } from '@/utils/error-message';
import type { TeamEditorState } from './team-graph';
import { TeamNotice, TeamSelect } from './TeamPrimitives';
import { blueprintStructuralIssues, patchBlueprintSummary, patchBlueprintWork, removeBlueprintWork, suggestBlueprintFromOrganization, withBlueprintWork, workBlueprintOf } from './team-work-blueprint';
import './team-workplan.css';

const TASK_KINDS: TeamBlueprintTaskKind[] = ['financials', 'business', 'valuation', 'challenge', 'specialist'];
const taskKindLabel = (kind: TeamBlueprintTaskKind, zh: boolean): string => zh
  ? ({ financials: '财报核查', business: '基本面', valuation: '估值', challenge: '反证挑战', specialist: '专项研究' } as const)[kind]
  : ({ financials: 'Financials', business: 'Business', valuation: 'Valuation', challenge: 'Challenge', specialist: 'Specialist' } as const)[kind];

interface TeamWorkPlanPreviewProps { teamId: string; semanticRevision: number; state: TeamEditorState; edit: (state: TeamEditorState) => void; zh: boolean; readOnly: boolean; online: boolean }

export function TeamWorkPlanPreview({ teamId, semanticRevision, state, edit, zh, readOnly, online }: TeamWorkPlanPreviewProps) {
  const blueprint = workBlueprintOf(state.config);
  const roles = state.config.roles;
  const lead = state.config.defaults.leadRoleId;
  const roleLabel = (roleId: string): string => state.display.roleLabels[roleId] || roles.find(role => role.id === roleId)?.responsibility?.slice(0, 24) || (zh ? '未命名岗位' : 'Untitled role');
  const [result, setResult] = useState<TeamWorkPlanPreviewResult | null>(null);
  const [submitted, setSubmitted] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const workLabel = (workId: string): string => {
    const work = blueprint?.works.find(item => item.workId === workId);
    return work ? `${roleLabel(work.roleId)} · ${taskKindLabel(work.taskKind, zh)}` : (zh ? '缺失工作项' : 'Missing work item');
  };
  const previewWorkLabel = (workKey: string): string => {
    const work = result?.work.find(item => item.workKey === workKey);
    if (!work) return zh ? '缺失工作项' : 'Missing work item';
    return `${roleLabel(work.roleId)} · ${work.taskKind === 'summary' ? (zh ? '汇总' : 'Summary') : taskKindLabel(work.taskKind, zh)}`;
  };
  const relationLabel = (relationId: string): string => {
    const relation = state.config.relations.find(item => item.id === relationId);
    return relation ? `${roleLabel(relation.fromRoleId)} → ${roleLabel(relation.toRoleId)}` : (zh ? '已移除关系' : 'Removed relation');
  };
  const signature = JSON.stringify(state.config);
  const stale = !!result && signature !== submitted;
  const issues = blueprintStructuralIssues(state.config);
  const patchConfig = (config: TeamSemanticConfig): void => edit({ ...state, config });
  const addWork = (): void => {
    if (!blueprint || readOnly) return;
    const leadRole = lead ?? '';
    const used = new Set(blueprint.works.map(work => work.roleId));
    const seat = roles.find(role => role.id !== leadRole && role.participation === 'enabled' && !used.has(role.id));
    if (!seat) return;
    const workId = `work-${blueprint.works.length + 1}-${Date.now().toString(36)}`.slice(0, 63);
    const work = { workId, roleId: seat.id, taskKind: 'specialist' as TeamBlueprintTaskKind, objective: '', expectedOutput: seat.expectedOutput, dependencyWorkIds: [] as string[], reviewerRoleId: leadRole || seat.id, reviewMode: (leadRole && leadRole !== seat.id ? 'independent' : 'self_check') as 'independent' | 'self_check' };
    patchConfig(withBlueprintWork(state.config, work));
  };
  const buildFromOrganization = (): void => {
    const suggested = suggestBlueprintFromOrganization(state.config);
    if (!suggested) return;
    patchConfig({ ...state.config, workBlueprint: suggested });
  };
  const refresh = async (): Promise<void> => {
    if (readOnly || !online) return;
    const current = ++seq.current;
    const submittedSignature = signature;
    setPending(true); setError('');
    try {
      const response = await teamsApi.workPlanPreview(teamId, { requestKey: crypto.randomUUID(), expectedSemanticRevision: semanticRevision, config: state.config });
      if (current !== seq.current) return;
      setResult(response); setSubmitted(submittedSignature);
    } catch (failure) {
      if (current === seq.current) setError(friendlyError(failure, zh, { zh: '结构预览未完成。', en: 'Structural preview failed.' }));
    } finally {
      if (current === seq.current) setPending(false);
    }
  };
  return <details className="team-workplan" id="team-workplan">
    <summary>{zh ? '研究分工与复核' : 'Research roles and reviews'}<ChevronRight className="size-3.5 shrink-0" aria-hidden="true" /></summary>
    <div className="team-workplan-content">
    <p className="team-muted team-small">{zh ? '在此编辑草稿的岗位、依赖与复核安排，保存并发布后生效。下方结构预览只读，不保存、不调用模型、不启动研究。' : 'Edit the draft roles, dependencies and reviews here, then save and publish to apply them. The read-only structural preview below never saves, calls a model or starts research.'}</p>
    {!blueprint && <TeamNotice><p>{zh ? '此组织仍使用旧版“独立研究 + 负责人汇总”规则。' : 'This organization still uses the legacy independent-research plus lead-summary rule.'}</p><Button variant="outline" size="sm" disabled={readOnly || !lead} onClick={buildFromOrganization}>{zh ? '根据当前组织建立标准研究分工' : 'Build a standard division from this organization'}</Button></TeamNotice>}
    {blueprint && <>
      <section className="team-workplan-works" aria-label={zh ? '工作项与复核安排' : 'Work items and reviews'}>
        {blueprint.works.map(work => <article className="team-workplan-work" key={work.workId}>
          <header><div><strong>{roleLabel(work.roleId)}</strong><span className="team-muted">{taskKindLabel(work.taskKind, zh)}</span></div><Button variant="ghost" size="icon" aria-label={`${zh ? '删除工作项' : 'Remove work'} ${roleLabel(work.roleId)}`} disabled={readOnly} onClick={() => patchConfig(removeBlueprintWork(state.config, work.workId))}><Trash2 size={14} /></Button></header>
          <div className="team-form-grid">
            <TeamSelect label={zh ? '工作类型' : 'Task kind'} value={work.taskKind} disabled={readOnly} options={TASK_KINDS.map(kind => ({ value: kind, label: taskKindLabel(kind, zh) }))} onChange={value => patchConfig(patchBlueprintWork(state.config, work.workId, { taskKind: value as TeamBlueprintTaskKind }))} />
            <TeamSelect label={zh ? '执行岗位' : 'Executing role'} value={work.roleId} disabled={readOnly} options={roles.filter(role => role.id !== lead).map(role => ({ value: role.id, label: roleLabel(role.id) }))} onChange={value => patchConfig(patchBlueprintWork(state.config, work.workId, { roleId: value }))} />
          </div>
          <label className="team-field"><span>{zh ? '本次研究目标' : 'Objective'}</span><Input maxLength={1000} value={work.objective} disabled={readOnly} onChange={event => patchConfig(patchBlueprintWork(state.config, work.workId, { objective: event.target.value }))} /></label>
          <label className="team-field"><span>{zh ? '预期交付' : 'Expected output'}</span><Textarea rows={2} maxLength={1000} value={work.expectedOutput} disabled={readOnly} onChange={event => patchConfig(patchBlueprintWork(state.config, work.workId, { expectedOutput: event.target.value }))} /></label>
          <fieldset className="team-permission-list" disabled={readOnly}><legend>{zh ? '必须先验收的依赖' : 'Dependencies that must be accepted first'}</legend>{blueprint.works.filter(item => item.workId !== work.workId).map(item => <label key={item.workId}><Checkbox checked={work.dependencyWorkIds.includes(item.workId)} onCheckedChange={checked => patchConfig(patchBlueprintWork(state.config, work.workId, { dependencyWorkIds: checked ? [...new Set([...work.dependencyWorkIds, item.workId])] : work.dependencyWorkIds.filter(dep => dep !== item.workId) }))} /><span>{workLabel(item.workId)}</span></label>)}{blueprint.works.length < 2 && <p className="team-muted team-small">{zh ? '尚无其他工作项。' : 'No other work items yet.'}</p>}</fieldset>
          <div className="team-form-grid">
            <TeamSelect label={zh ? '复核岗位' : 'Reviewer'} value={work.reviewerRoleId} disabled={readOnly} options={roles.map(role => ({ value: role.id, label: roleLabel(role.id) }))} onChange={value => patchConfig(patchBlueprintWork(state.config, work.workId, { reviewerRoleId: value }))} />
            <TeamSelect label={zh ? '复核方式' : 'Review mode'} value={work.reviewMode} disabled={readOnly} options={[{ value: 'independent', label: zh ? '独立复核（不同股友）' : 'Independent (different friend)' }, { value: 'self_check', label: zh ? '同岗自检' : 'Same-role self-check' }]} onChange={value => patchConfig(patchBlueprintWork(state.config, work.workId, { reviewMode: value as 'independent' | 'self_check' }))} />
          </div>
        </article>)}
      </section>
      <Button variant="outline" size="sm" disabled={readOnly || blueprint.works.length >= 5 || !lead} onClick={addWork}><Plus size={14} />{zh ? '增加工作项' : 'Add work item'}</Button>
      <section className="team-workplan-summary">
        <h4>{zh ? '负责人汇总（唯一）' : 'Lead summary (single)'}</h4>
        <p className="team-muted team-small">{zh ? `负责人：${lead ? roleLabel(lead) : '未选择'}。汇总工作不能手工删除；负责人自身不额外执行研究。` : `Lead: ${lead ? roleLabel(lead) : 'not selected'}. The summary work cannot be removed and the lead does not execute extra research.`}</p>
        <label className="team-field"><span>{zh ? '汇总交付要求' : 'Summary delivery requirement'}</span><Textarea rows={2} maxLength={1000} value={blueprint.summary.expectedOutput} disabled={readOnly} onChange={event => patchConfig(patchBlueprintSummary(state.config, { expectedOutput: event.target.value }))} /></label>
        <div className="team-form-grid">
          <TeamSelect label={zh ? '汇总复核岗位' : 'Summary reviewer'} value={blueprint.summary.reviewerRoleId} disabled={readOnly} options={roles.map(role => ({ value: role.id, label: roleLabel(role.id) }))} onChange={value => patchConfig(patchBlueprintSummary(state.config, { reviewerRoleId: value, reviewMode: value === lead ? 'self_check' : 'independent' }))} />
          <TeamSelect label={zh ? '汇总复核方式' : 'Summary review mode'} value={blueprint.summary.reviewMode} disabled={readOnly} options={[{ value: 'independent', label: zh ? '独立复核（不同股友）' : 'Independent (different friend)' }, { value: 'self_check', label: zh ? '负责人自检（非独立复核）' : 'Lead self-check (not independent)' }]} onChange={value => patchConfig(patchBlueprintSummary(state.config, { reviewMode: value as 'independent' | 'self_check' }))} />
        </div>
      </section>
    </>}
    {!!issues.length && <TeamNotice error><strong>{zh ? `${issues.length} 项结构问题` : `${issues.length} structural issues`}</strong><ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}{issue.workId ? ` (${workLabel(issue.workId)})` : ''}</li>)}</ul></TeamNotice>}
    <div className="team-inline-actions"><Button size="sm" disabled={pending || readOnly || !online} onClick={() => void refresh()}><RefreshCw size={14} />{pending ? (zh ? '预览中…' : 'Previewing…') : (zh ? '生成只读结构预览' : 'Generate read-only structural preview')}</Button>{!online && <span className="team-muted team-small">{zh ? '离线时无法请求服务端预览。' : 'Server preview requires a connection.'}</span>}</div>
    {error && <TeamNotice error>{error}</TeamNotice>}
    {result && <section className="team-workplan-result" aria-live="polite">
      <h4>{zh ? '研究分工预览（只读）' : 'Research division preview (read-only)'}</h4>
      <p className="team-small">{result.mode === 'blueprint_v1' ? (zh ? '模式：工作蓝图 v1' : 'Mode: work blueprint v1') : (zh ? '模式：旧版独立研究 + 负责人汇总' : 'Mode: legacy independent research plus lead summary')} · {result.structurallyValid ? (zh ? '结构有效' : 'structurally valid') : (zh ? '结构存在问题' : 'structural issues') }{result.minimumCallCount !== null ? ` · ${zh ? '最低授权调用额度' : 'minimum reserved calls'} ${result.minimumCallCount}` : ''}</p>
      {stale && <TeamNotice error>{zh ? '草稿已继续修改，此预览已过期，请重新生成。' : 'The draft changed after this preview; regenerate it.'}</TeamNotice>}
      {!!result.work.length && <div className="team-workplan-table-scroll" tabIndex={0} role="region" aria-label={zh ? '只读研究分工表' : 'Read-only research division table'}><table className="team-workplan-table"><thead><tr><th>{zh ? '工作' : 'Work'}</th><th>{zh ? '执行岗位' : 'Executor'}</th><th>{zh ? '依赖' : 'Depends on'}</th><th>{zh ? '复核' : 'Reviewer'}</th></tr></thead><tbody>{result.work.map(work => <tr key={work.workKey}><td>{previewWorkLabel(work.workKey)}</td><td>{roleLabel(work.roleId)}</td><td>{work.dependencyWorkKeys.length ? work.dependencyWorkKeys.map(previewWorkLabel).join('、') : (zh ? '无' : 'None')}</td><td>{roleLabel(work.reviewerRoleId)} · {work.reviewMode === 'independent' ? (zh ? '独立' : 'Independent') : (zh ? '自检' : 'Self-check')}</td></tr>)}</tbody></table></div>}
      {!!result.issues.length && <TeamNotice error><strong>{zh ? '服务端结构错误' : 'Server structural errors'}</strong><ul>{result.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.code} · {issue.message}</li>)}</ul></TeamNotice>}
      {!!result.warnings.length && <TeamNotice><strong>{zh ? '提示' : 'Warnings'}</strong><ul>{result.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.code} · {warning.message}</li>)}</ul></TeamNotice>}
      {!!result.nonParticipatingRoleIds.length && <p className="team-muted team-small">{zh ? '本次未参与：' : 'Not participating: '}{result.nonParticipatingRoleIds.map(roleLabel).join('、')}</p>}
      {!!result.unusedReviewRelationIds.length && <p className="team-muted team-small">{zh ? '本次未采用的复核线：' : 'Unused review relations: '}{result.unusedReviewRelationIds.map(relationLabel).join('、')}</p>}
    </section>}
    </div>
  </details>;
}
