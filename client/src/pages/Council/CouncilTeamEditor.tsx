/**
 * CouncilTeamEditor.tsx — 理事会团队编辑器：成员列表增删改、预设一键套用、Web 研究开关。
 *
 * 职责边界：
 *  - 受控组件（value/onChange）：维护 CouncilConfig.members 与 webResearch；
 *  - 提供：本地智能体一键分配、预设团队套用（COUNCIL_TEAM_PRESETS）、成员卡片列表
 *    （编辑/删除）、添加面板（COUNCIL_MEMBER_TEMPLATES 模板或自定义）、
 *    Web 研究开关（关闭时剔除非本地成员的 web 研究焦点）；
 *  - 成员保存走 saveMember：唯一 manager 约束 + validateCouncilSettings 校验后才回传 onChange。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilNewDialog、AgentBuilder/CouncilConfigEditor。
 *  - 下游（调用哪些 hooks/api/组件）：useCouncilModels（options/localAgents/memberLabel/refetch）；
 *    useCouncilModels 的 assignLocalAgents；@shared/council-templates 的模板与预设工厂；
 *    validateCouncilSettings；CouncilMemberAvatar / CouncilMemberEditor。
 * 关键约定：
 *  - 成员数量上限 6、下限 2（删除按钮在 ≤2 或 manager 时禁用）；
 *  - manager 唯一：保存 manager 成员时把其余 manager 降级为 researcher；
 *  - 新成员 id 由 模板id-16位随机串 生成；自定义成员四项文案清空、研究焦点清空；
 *  - 模型列表加载失败时给"重试"入口（models.refetch）。
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { CouncilConfig, CouncilMember } from '@shared/council.interface';
import {
  COUNCIL_MEMBER_TEMPLATES,
  COUNCIL_TEAM_PRESETS,
  councilLanguage,
  createCouncilMember,
  createCouncilPreset,
  type CouncilMemberTemplate,
  type CouncilTemplateId,
} from '@shared/council-templates';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { validateCouncilSettings } from '@/utils/council-state';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import CouncilMemberEditor from './CouncilMemberEditor';
import { assignLocalAgents, useCouncilModels } from './useCouncilModels';
import { Link } from 'react-router-dom';

interface CouncilTeamEditorProps {
  value: CouncilConfig;
  onChange: (value: CouncilConfig) => void;
}

/** 理事会团队编辑器（受控）。 */
export default function CouncilTeamEditor({ value, onChange }: CouncilTeamEditorProps) {
  const { t, i18n } = useTranslation();
  // === 状态声明区 ===
  // 文案语言口径 / Web 开关的表单 id
  const language = councilLanguage(i18n.language);
  const webId = useId();
  // 添加面板开关 / 当前编辑中的成员（null = 关闭编辑器）
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CouncilMember | null>(null);
  // 模型选项与本地智能体（共享查询）
  const models = useCouncilModels();

  // === 事件处理区 ===
  // 选模板新增：生成新成员（轮转分配本地智能体）后直接进入编辑；
  // custom=true 时清空四项文案与研究焦点（自定义成员起点）
  const selectTemplate = (templateId: CouncilTemplateId, custom = false) => {
    if (value.members.length >= 6) return;
    const [member] = assignLocalAgents(
      [
        createCouncilMember(
          templateId,
          i18n.language,
          `${templateId}-${crypto.randomUUID().replace(/-/gu, '').slice(0, 16)}`,
        ),
      ],
      models.localAgents,
    );
    setEditing(
      custom
        ? {
            ...member,
            name: '',
            roleTitle: '',
            personality: '',
            instructions: '',
            researchFocus: [],
          }
        : member,
    );
    setAdding(false);
  };
  // 保存成员：存在则替换否则追加；manager 唯一约束（其余降级 researcher）；
  // 校验通过才回传 onChange，问题文案返回给编辑器展示
  const saveMember = (member: CouncilMember): string | null => {
    const exists = value.members.some((item: CouncilMember) => item.id === member.id);
    let members = exists
      ? value.members.map((item: CouncilMember) => (item.id === member.id ? member : item))
      : [...value.members, member];
    if (member.role === 'manager')
      members = members.map((item: CouncilMember) =>
        item.id !== member.id && item.role === 'manager' ? { ...item, role: 'researcher' } : item,
      );
    const problem = validateCouncilSettings({ ...value, enabled: true, members }, undefined);
    if (problem) return t(`council.${problem}`);
    onChange({ ...value, members });
    return null;
  };

  return (
    <div className="space-y-4">
      {/* === 渲染区 === */}
      {/* 什么时候走到这里：有可用本地智能体且仍有成员未用本地模式——一键分配按钮 */}
      {models.localAgents.some((agent) => agent.available) &&
        value.members.some((member) => member.executionMode !== 'local') && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-auto min-h-9 whitespace-normal"
            onClick={() =>
              onChange({ ...value, members: assignLocalAgents(value.members, models.localAgents) })
            }
          >
            <Bot className="size-4" />
            {t('council.localAgents.useForTeam')}
          </Button>
        )}
      {/* 预设团队按钮组（悬浮出描述） */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('council.members.presets')}>
        {COUNCIL_TEAM_PRESETS.map((preset) => (
          <Tooltip key={preset.id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onChange({
                    ...value,
                    members: assignLocalAgents(
                      createCouncilPreset(preset.id, i18n.language),
                      models.localAgents,
                    ),
                  });
                  setAdding(false);
                }}
              >
                {preset.name[language]}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{preset.description[language]}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {/* 成员计数与人数边界说明 */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t('council.members.selected', { count: value.members.length })}
        </h3>
        <span className="text-[11px] text-muted-foreground">{t('council.members.bounds')}</span>
      </div>
      {/* 成员卡片列表：头像/名字/职务徽标/模型标签 + 编辑/删除 */}
      <div className="space-y-2">
        {value.members.map((member: CouncilMember) => (
          <div
            key={member.id}
            className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3"
          >
            <CouncilMemberAvatar role={member.role} avatar={member.avatar} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{member.name}</span>
                {/* 什么时候走到这里：该成员是 manager——追加"主持人"小徽标 */}
                {member.role === 'manager' && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    {t('council.members.moderator')}
                  </span>
                )}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {member.roleTitle || t(`council.roles.${member.role}`)}
              </p>
              <p
                className="mt-1 truncate text-[10px] text-muted-foreground"
                title={models.memberLabel(member)}
              >
                {models.memberLabel(member)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={t('council.members.editMember', { name: member.name })}
              onClick={() => setEditing(member)}
            >
              <Pencil className="size-3.5" />
            </Button>
            {/* 删除：≤2 人或 manager 时禁用（manager 给专门提示） */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              disabled={value.members.length <= 2 || member.role === 'manager'}
              title={
                member.role === 'manager'
                  ? t('council.members.removeModeratorHint')
                  : t('council.members.removeMember', { name: member.name })
              }
              aria-label={t('council.members.removeMember', { name: member.name })}
              onClick={() =>
                onChange({
                  ...value,
                  members: value.members.filter((item: CouncilMember) => item.id !== member.id),
                })
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {/* 什么时候走到这里：模型列表加载失败——错误提示 + 重试 */}
      {models.error && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('council.members.modelsLoadFailed')}</span>
          <Button
            type="button"
            variant="ghost"
            className="h-auto p-0 text-xs text-primary hover:underline"
            onClick={models.refetch}
          >
            {t('council.retry')}
          </Button>
        </div>
      )}
      {/* 添加面板：模板网格 + 自定义入口；否则显示"添加成员"虚线按钮（满 6 人禁用） */}
      {adding ? (
        <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t('council.members.chooseTemplate')}</p>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t('council.close')}
              onClick={() => setAdding(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {COUNCIL_MEMBER_TEMPLATES.map((template: CouncilMemberTemplate) => (
              <button
                key={template.id}
                type="button"
                onClick={() => selectTemplate(template.id)}
                className="flex items-start gap-2 rounded-lg border border-border bg-card p-2.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CouncilMemberAvatar role={template.role} avatar={template.id} className="size-8" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">
                    {template.text[language].roleTitle}
                  </span>
                  <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                    {template.text[language].description}
                  </span>
                </span>
              </button>
            ))}
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-16 justify-start whitespace-normal text-xs"
              onClick={() => selectTemplate('value', true)}
            >
              <Plus className="size-4" />
              {t('council.members.custom')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full border-dashed"
          disabled={value.members.length >= 6}
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" />
          {t(value.members.length >= 6 ? 'council.members.full' : 'council.members.add')}
        </Button>
      )}
      {/* 什么时候走到这里：存在本地执行成员——本地工具/预算提示（含预算入口链接） */}
      {value.members.some((member) => member.executionMode === 'local') && (
        <div className="rounded-xl bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
          <p>{t('council.localAgents.toolsHint')}</p>
          <p className="mt-2">
            {t('council.localAgents.budgetHint')}{' '}
            <Link to="/settings/budget" className="text-primary hover:underline">
              {t('council.budget.open')}
            </Link>
          </p>
        </div>
      )}
      {/* 什么时候走到这里：存在非本地成员——Web 研究开关；
          关闭时同步剔除非本地成员的 'web' 研究焦点 */}
      {value.members.some((member) => member.executionMode !== 'local') && (
        <div className="rounded-xl bg-muted/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={webId} className="text-sm">
              {t('council.members.webResearch')}
            </Label>
            <Switch
              id={webId}
              checked={Boolean(value.webResearch)}
              onCheckedChange={(enabled: boolean) =>
                onChange({
                  ...value,
                  webResearch: enabled,
                  members: enabled
                    ? value.members
                    : value.members.map((member: CouncilMember) =>
                        member.executionMode === 'local'
                          ? member
                          : {
                              ...member,
                              researchFocus: member.researchFocus?.filter(
                                (focus) => focus !== 'web',
                              ),
                            },
                      ),
                })
              }
            />
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t('council.members.webResearchHint')}
          </p>
        </div>
      )}
      {/* 成员编辑器（按成员 id 作 key 重建，保证表单状态干净） */}
      {editing && (
        <CouncilMemberEditor
          key={editing.id}
          member={editing}
          webResearch={Boolean(value.webResearch)}
          modelOptions={models.options}
          localAgents={models.localAgents}
          onSave={saveMember}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
