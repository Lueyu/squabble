import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { TeamRelation } from '@shared/team-workspace.interface';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { relationLabel, type TeamEditorState } from './team-graph';
import type { TeamRelationView } from './team-editor-navigation';
import { TeamSelect } from './TeamPrimitives';

const RELATION_KINDS = ['reports_to', 'delegates_to', 'reviews'] as const;

interface TeamRelationsProps {
  state: TeamEditorState;
  view: TeamRelationView | null;
  show: (view: TeamRelationView) => void;
  close: () => void;
  onRestoreFocus: (event: Event) => void;
  apply: (id: string, relation: TeamRelation | null) => void;
  zh: boolean;
  readOnly: boolean;
}

export function TeamRelations({ state, view, show, close, onRestoreFocus, apply, zh, readOnly }: TeamRelationsProps) {
  const roles = state.config.roles.map(role => ({
    value: role.id,
    label: state.display.roleLabels[role.id] || (zh ? '未命名岗位' : 'Untitled role'),
  }));
  const roleName = (id: string) => roles.find(role => role.value === id)?.label ?? (zh ? '岗位不可用' : 'Role unavailable');
  const editing = view?.kind === 'edit' ? state.config.relations.find(relation => relation.id === view.id) : undefined;
  const adding = view?.kind === 'add' ? view : null;
  const from = adding?.fromRoleId ?? roles[0]?.value ?? '';
  const relations = state.config.relations.filter(relation => {
    if (view?.kind === 'related') return relation.fromRoleId === view.roleId || relation.toRoleId === view.roleId;
    if (view?.kind === 'issues') return view.ids.includes(relation.id);
    return true;
  });

  return <Dialog open={view !== null} onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="team-dialog team-relation-dialog" showCloseButton={false}
      onEscapeKeyDown={event => event.stopPropagation()} onCloseAutoFocus={onRestoreFocus}>
      {editing || adding ? <RelationForm
        key={editing?.id ?? 'new'}
        initial={editing ?? {
          id: '', fromRoleId: from, toRoleId: adding?.toRoleId ?? roles.find(role => role.value !== from)?.value ?? '',
          kind: 'reports_to', responsibilityScope: '',
        }}
        roles={roles} zh={zh} readOnly={readOnly} close={close} apply={apply}
      /> : <>
        <DialogHeader>
          <DialogTitle>{zh ? '汇报与协作' : 'Reporting and collaboration'}</DialogTitle>
          <DialogDescription>
            {view?.kind === 'related' ? roleName(view.roleId)
              : view?.kind === 'issues' ? (zh ? '检查相关汇报关系的方向。' : 'Review the direction of these reporting relations.')
                : (zh ? '选择一条关系查看属性。' : 'Select a relation to view its properties.')}
          </DialogDescription>
        </DialogHeader>
        <ul className="team-relation-list">
          {relations.map(relation => <li key={relation.id}>
            <Button type="button" variant="outline" onClick={() => show({ kind: 'edit', id: relation.id })}>
              <span>
                <strong>{roleName(relation.fromRoleId)} · {relationLabel(relation.kind, zh)} · {roleName(relation.toRoleId)}</strong>
                {relation.responsibilityScope && <small>{relation.responsibilityScope}</small>}
              </span>
              <ChevronRight aria-hidden="true" />
            </Button>
          </li>)}
        </ul>
        {!relations.length && <p className="team-muted">{zh ? '暂无关系。' : 'No relations yet.'}</p>}
        <div className="team-inline-actions">
          {!readOnly && <Button disabled={roles.length < 2} onClick={() => show(view?.kind === 'related'
            ? { kind: 'add', fromRoleId: view.roleId } : { kind: 'add' })}>
            <Plus aria-hidden="true" />{zh ? '新增关系' : 'Add relation'}
          </Button>}
          {view?.kind === 'related' && <Button variant="outline" onClick={() => show({ kind: 'all' })}>{zh ? '查看全部关系' : 'View all relations'}</Button>}
          <Button variant="outline" onClick={close}>{zh ? '关闭' : 'Close'}</Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}

function RelationForm({ initial, roles, zh, readOnly, close, apply }: {
  initial: TeamRelation;
  roles: { value: string; label: string }[];
  zh: boolean;
  readOnly: boolean;
  close: () => void;
  apply: TeamRelationsProps['apply'];
}) {
  const [relation, setRelation] = useState(initial);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const existing = Boolean(initial.id);
  const editable = roles.some(role => role.value === relation.fromRoleId) &&
    roles.some(role => role.value === relation.toRoleId) && relation.fromRoleId !== relation.toRoleId &&
    (relation.kind !== 'reports_to' || Boolean(relation.responsibilityScope.trim()));
  const endpointOptions = (value: string, other: string) => [
    ...(!roles.some(role => role.value === value) ? [{ value, label: zh ? '选择岗位' : 'Choose a role', disabled: true }] : []),
    ...roles.filter(role => role.value !== other || role.value === value),
  ];
  const applyRelation = () => {
    if (readOnly || !editable) return;
    const id = initial.id || crypto.randomUUID();
    apply(id, { ...relation, id });
  };

  return <>
    <DialogHeader>
      <DialogTitle ref={titleRef} tabIndex={-1}>
        {readOnly ? (zh ? '查看汇报与协作' : 'View relation')
          : existing ? (zh ? '编辑汇报与协作' : 'Edit relation') : (zh ? '新增关系' : 'Add relation')}
      </DialogTitle>
    </DialogHeader>
    <form className="team-relation-form" onSubmit={event => { event.preventDefault(); applyRelation(); }}>
      <TeamSelect label={zh ? '起点岗位' : 'From role'} value={relation.fromRoleId}
        options={endpointOptions(relation.fromRoleId, relation.toRoleId)} disabled={readOnly}
        onChange={fromRoleId => setRelation({ ...relation, fromRoleId })} />
      <TeamSelect label={zh ? '关系类型' : 'Relation type'} value={relation.kind} disabled={readOnly}
        options={RELATION_KINDS.map(kind => ({ value: kind, label: relationLabel(kind, zh) }))}
        onChange={value => { const kind = RELATION_KINDS.find(candidate => candidate === value); if (kind) setRelation({ ...relation, kind }); }} />
      <TeamSelect label={zh ? '终点岗位' : 'To role'} value={relation.toRoleId}
        options={endpointOptions(relation.toRoleId, relation.fromRoleId)} disabled={readOnly}
        onChange={toRoleId => setRelation({ ...relation, toRoleId })} />
      <label className="team-field">
        <span>{zh ? '责任范围 / 交付要求' : 'Responsibility scope / delivery'}</span>
        <Textarea rows={1} maxLength={1000} value={relation.responsibilityScope} readOnly={readOnly}
          required={relation.kind === 'reports_to'} onChange={event => setRelation({ ...relation, responsibilityScope: event.target.value })} />
      </label>
      {!readOnly && existing && <div className="team-inline-actions">
        <Button type="button" variant="outline" onClick={() => setRelation({ ...relation, fromRoleId: relation.toRoleId, toRoleId: relation.fromRoleId })}>
          {zh ? '反转关系方向' : 'Reverse relation'}
        </Button>
        <Button type="button" variant="outline" onClick={() => apply(initial.id, null)}>{zh ? '删除关系' : 'Delete relation'}</Button>
      </div>}
      <div className="team-relation-footer">
        <DialogDescription>{readOnly ? (zh ? '当前组织为只读。' : 'This organization is read-only.')
          : (zh ? '应用后可在组织页面保存团队草稿。' : 'Apply these edits, then save the team draft from the organization page.')}</DialogDescription>
        <div className="team-inline-actions">
          {!readOnly && <Button type="submit" disabled={!editable}>{zh ? '应用到草稿' : 'Apply to draft'}</Button>}
          <Button type="button" variant="outline" onClick={close}>{readOnly ? (zh ? '关闭' : 'Close') : (zh ? '取消' : 'Cancel')}</Button>
        </div>
      </div>
    </form>
  </>;
}
