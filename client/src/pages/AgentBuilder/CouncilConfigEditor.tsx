/**
 * CouncilConfigEditor.tsx — 智能体向导里的投委会配置编辑器：成员团队编辑 + 交易节奏（cadence）数值。
 *
 * 职责边界：
 *  - 受控组件：投委会配置（council）与交易节奏（cadence）的展示与编辑，全部变更经
 *    onCouncilChange / onCadenceChange 回调上抛，不在本组件内持久化；
 *  - defaultCouncil 是纯工厂函数，供向导初始化新配置使用（不依赖 React）。
 * 上下游：
 *  - 上游（路由入口/谁引用）：AgentBuilder/BuilderWizard.tsx。
 *  - 下游（调用哪些 hooks/api/组件）：useTranslation；Council/CouncilTeamEditor；Input/Label/Switch；
 *    @shared/council-templates 的 createCouncilPreset；@/utils/council-state 的 DEFAULT_CADENCE。
 * 关键约定：
 *  - council.enabled=false 时团队编辑器不渲染（仅保留规则模式提示文案）；
 *    注意 Switch 始终渲染，避免 hook/条件渲染位置差异。
 *  - cadence 字段由 DEFAULT_CADENCE 的键驱动渲染，数值约束（step/min/max）按字段名特判。
 */
import { useTranslation } from 'react-i18next';
import { CalendarClock, Users } from 'lucide-react';
import type { CouncilConfig, TradingCadence } from '@shared/council.interface';
import { createCouncilPreset } from '@shared/council-templates';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_CADENCE } from '@/utils/council-state';
import CouncilTeamEditor from '@/pages/Council/CouncilTeamEditor';

/** 新建向导用的默认投委会配置：启用、balanced 预设成员（按语言本地化）、不开网络调研。 */
export function defaultCouncil(language: string): CouncilConfig {
  return { enabled: true, members: createCouncilPreset('balanced', language), webResearch: false };
}

export default function CouncilConfigEditor({
  council,
  cadence,
  onCouncilChange,
  onCadenceChange,
}: {
  council: CouncilConfig;
  cadence: TradingCadence;
  onCouncilChange: (value: CouncilConfig) => void;
  onCadenceChange: (value: TradingCadence) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      {/* 第一节：投委会开关 + 成员团队编辑器 */}
      <section className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label
              htmlFor="council-enabled"
              className="flex items-center gap-2 text-base font-semibold"
            >
              <Users className="size-5 text-primary" />
              {t('council.team.title')}
            </Label>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t('council.team.intro')}
            </p>
          </div>
          {/* 启用开关：整体翻转 enabled，其余配置原样保留 */}
          <Switch
            id="council-enabled"
            checked={council.enabled}
            onCheckedChange={(enabled: boolean) => onCouncilChange({ ...council, enabled })}
          />
        </div>
        {/* 状态提示：启用→团队提示；关闭→仅规则模式说明 */}
        <p className="text-xs leading-5 text-muted-foreground">
          {t(council.enabled ? 'council.team.enabledHint' : 'council.team.rulesOnly')}
        </p>
        {/* 什么时候走到这里：投委会已启用——渲染成员团队编辑器 */}
        {council.enabled && <CouncilTeamEditor value={council} onChange={onCouncilChange} />}
      </section>
      {/* 第二节：交易节奏（每周节奏参数）数值编辑 */}
      <section className="space-y-4 rounded-xl border border-border p-4">
        <div>
          <h4 className="flex items-center gap-2 font-semibold">
            <CalendarClock className="size-5 text-primary" />
            {t('council.cadence.title')}
          </h4>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t('council.cadence.intro')}
          </p>
        </div>
        {/* 逐字段渲染数字输入：step/min/max 按字段名特判（换手率为小数、冷却期可为 0 等） */}
        <div className="grid gap-4 sm:grid-cols-2">
          {(Object.keys(DEFAULT_CADENCE) as Array<keyof TradingCadence>).map((field) => (
            <div key={field} className="space-y-2">
              <Label htmlFor={`cadence-${field}`}>{t(`council.cadence.${field}`)}</Label>
              <Input
                id={`cadence-${field}`}
                type="number"
                step={field === 'maxWeeklyTurnoverPct' ? 0.1 : 1}
                min={
                  field === 'cooldownTradingDays' ? 0 : field === 'maxWeeklyTurnoverPct' ? 0.1 : 1
                }
                max={
                  field === 'maxWeeklyTurnoverPct' ? 100 : field === 'maxOrdersPerWeek' ? 20 : 60
                }
                value={cadence[field]}
                onChange={(event) =>
                  onCadenceChange({ ...cadence, [field]: Number(event.target.value) })
                }
              />
            </div>
          ))}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {t('council.cadence.calendarHint')}
        </p>
      </section>
    </div>
  );
}
