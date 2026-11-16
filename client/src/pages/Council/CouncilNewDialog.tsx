/**
 * CouncilNewDialog.tsx — 新建理事会会话弹窗：标的、团队配置、可选绑定 Builder 档案。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, MessageCircle, X } from 'lucide-react';
import type { BuilderProfile } from '@shared/api.interface';
import type { CouncilConfig, CreateCouncilSession } from '@shared/council.interface';
import { createCouncilPreset } from '@shared/council-templates';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateCouncilSettings } from '@/utils/council-state';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import CouncilTeamEditor from './CouncilTeamEditor';
import { useQuery } from '@tanstack/react-query';
import { fetchLocalAgents } from '@/api/local-agents';
import { assignLocalAgents } from './useCouncilModels';

interface CouncilNewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: BuilderProfile[];
  loading: boolean;
  error: unknown;
  pending: boolean;
  initialProfileId: string;
  initialTicker: string;
  initialTeam?: CouncilConfig;
  onCreate: (request: CreateCouncilSession) => Promise<void>;
}

/** 新建理事会会话弹窗。 */
export default function CouncilNewDialog({
  open,
  onOpenChange,
  profiles,
  loading,
  error,
  pending,
  initialProfileId,
  initialTicker,
  initialTeam,
  onCreate,
}: CouncilNewDialogProps) {
  const { t, i18n } = useTranslation();
  // === 状态声明区 ===
  // 档案 id / 标的 / 团队配置 / 表单错误
  const [profileId, setProfileId] = useState(initialProfileId);
  const [ticker, setTicker] = useState(initialTicker);
  const [team, setTeam] = useState<CouncilConfig>(
    () =>
      initialTeam ?? {
        enabled: true,
        members: createCouncilPreset('balanced', i18n.language),
        webResearch: false,
      },
  );
  const [formError, setFormError] = useState<string | null>(null);
  // 本地智能体列表（用于自动分配）
  const agents = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  // 一次性初始化守卫：已有初始团队/档案则跳过档案预填；已有团队或无档案则跳过智能体分配
  const initializedAgents = useRef(Boolean(initialTeam) || Boolean(initialProfileId));
  const initializedProfile = useRef(Boolean(initialTeam) || !initialProfileId);
  // === 数据获取区（副作用） ===
  // 档案到位后一次性预填团队：沿用档案理事会成员，剔除非本地成员的 web 研究焦点
  useEffect(() => {
    if (initializedProfile.current) return;
    const profile = profiles.find((item: BuilderProfile) => item.id === initialProfileId);
    if (!profile) return;
    if (profile.config.council?.members.length)
      setTeam({
        enabled: true,
        webResearch: false,
        members: profile.config.council.members.map((member) => ({
          ...member,
          researchFocus: member.researchFocus?.filter(
            (focus) => focus !== 'web' || member.executionMode === 'local',
          ),
        })),
      });
    initializedProfile.current = true;
  }, [profiles, initialProfileId]);
  // 智能体列表首次到位后一次性轮转分配到团队成员
  useEffect(() => {
    if (initializedAgents.current || !agents.isSuccess) return;
    initializedAgents.current = true;
    setTeam((current) => ({
      ...current,
      members: assignLocalAgents(current.members, agents.data),
    }));
  }, [agents.isSuccess, agents.data]);

  // === 事件处理区 ===
  // 用户手动改团队：置位两个初始化守卫（不再被自动预填覆盖），清表单错误
  const changeTeam = (value: CouncilConfig) => {
    initializedProfile.current = true;
    initializedAgents.current = true;
    setTeam(value);
    setFormError(null);
  };
  // 创建会话：两道校验（标的/档案、团队设置）后回调 onCreate
  const create = async () => {
    if (pending) return;
    const symbol = ticker.trim().toUpperCase();
    if (
      !/^[A-Z0-9][A-Z0-9.^-]{0,19}$/u.test(symbol) ||
      (profileId && !profiles.some((profile: BuilderProfile) => profile.id === profileId))
    ) {
      setFormError(t('council.newInvalid'));
      return;
    }
    const invalid = validateCouncilSettings(team, undefined);
    if (invalid) {
      setFormError(t(`council.${invalid}`));
      return;
    }
    setFormError(null);
    try {
      await onCreate({
        ticker: symbol,
        ...(profileId ? { profileId } : {}),
        members: team.members,
        webResearch: Boolean(team.webResearch),
        language: i18n.language.startsWith('zh') ? 'zh-CN' : 'en',
      });
    } catch (cause) {
      setFormError(errorMessage(cause, t('council.actionFailed')));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* === 渲染区 === */}
      <DialogContent
        className="flex max-h-[92dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        {/* 弹窗头：标题 + 说明 + 右上关闭 */}
        <DialogHeader className="shrink-0 border-b border-border p-5 pr-14 text-left">
          <DialogTitle>{t('council.newTitle')}</DialogTitle>
          <DialogDescription>{t('council.newHint')}</DialogDescription>
        </DialogHeader>
        <div className="absolute right-3 top-3">
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={t('council.close')}>
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {/* 标的输入 */}
            <div className="space-y-2">
              <Label htmlFor="council-ticker">{t('council.ticker')}</Label>
              <Input
                autoFocus
                id="council-ticker"
                value={ticker}
                maxLength={20}
                placeholder="AAPL / 0700.HK / 600519.SS"
                onChange={(event) => setTicker(event.target.value)}
              />
            </div>
            {/* 团队编辑器 */}
            <CouncilTeamEditor value={team} onChange={changeTeam} />
            {/* 可折叠的档案选择区：有初始档案时默认展开 */}
            <Collapsible
              defaultOpen={Boolean(initialProfileId)}
              className="rounded-xl border border-border bg-card"
            >
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-h-9 w-full justify-between py-2 text-left text-xs"
                >
                  <span className="min-w-0 whitespace-normal">
                    {t('council.members.profileOptional')}
                  </span>
                  <ChevronDown className="size-3.5" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 px-3 pb-3">
                <Label htmlFor="council-profile" className="sr-only">
                  {t('council.profile')}
                </Label>
                <select
                  id="council-profile"
                  value={profileId}
                  disabled={loading}
                  onChange={(event) => {
                    setProfileId(event.target.value);
                    const profile = profiles.find(
                      (item: BuilderProfile) => item.id === event.target.value,
                    );
                    // 什么时候走到这里：所选档案带理事会成员——覆盖团队（保留 web 焦点仅当已开 webResearch 或本地执行）
                    if (profile?.config.council?.members.length)
                      changeTeam({
                        ...team,
                        members: profile.config.council.members.map((member) => ({
                          ...member,
                          researchFocus: member.researchFocus?.filter(
                            (focus) =>
                              focus !== 'web' ||
                              team.webResearch ||
                              member.executionMode === 'local',
                          ),
                        })),
                      });
                  }}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">{t('council.members.standalone')}</option>
                  {profiles.map((profile: BuilderProfile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.config.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('council.members.profileHint')}
                </p>
                {/* 什么时候走到这里：档案列表加载失败——错误提示 */}
                {error ? (
                  <p role="alert" className="text-xs text-muted-foreground">
                    {t('council.members.profilesLoadFailed')}
                  </p>
                ) : null}
              </CollapsibleContent>
            </Collapsible>
          </div>
          {/* 底部：表单错误 + 提交按钮（创建中/智能体查询中禁用） */}
          <div className="shrink-0 space-y-3 border-t border-border p-4">
            {formError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {formError}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={pending || agents.isPending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MessageCircle className="size-4" />
              )}
              {t('council.startChat')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
