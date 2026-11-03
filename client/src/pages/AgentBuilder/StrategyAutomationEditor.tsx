import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarClock, SlidersHorizontal } from 'lucide-react';
import type { CouncilMember } from '@shared/council.interface';
import { DEFAULT_STRATEGY_AUTOMATION, type StrategyAutomationConfig } from '@shared/strategy.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import CouncilMemberEditor from '@/pages/Council/CouncilMemberEditor';
import { useCouncilModels } from '@/pages/Council/useCouncilModels';

export default function StrategyAutomationEditor({ value, councilEnabled, notifications, onChange, onNotificationsChange }: {
  value?: StrategyAutomationConfig; councilEnabled: boolean; notifications: boolean;
  onChange: (value: StrategyAutomationConfig) => void; onNotificationsChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const models = useCouncilModels();
  const [editingReviewer, setEditingReviewer] = useState(false);
  const config = value ?? DEFAULT_STRATEGY_AUTOMATION;
  const reviewer: CouncilMember = config.fastReviewer ?? { id: 'fast-reviewer', role: 'researcher',
    name: t('strategy.reviewerName'), model: 'fast', executionMode: 'model', instructions: '' };
  const update = (patch: Partial<StrategyAutomationConfig>) => onChange({ ...config, ...patch });
  return <section className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4" aria-label={t('strategy.title')}>
    <div className="flex items-start justify-between gap-4">
      <div><Label htmlFor="strategy-enabled" className="flex items-center gap-2 text-base font-semibold">
        <CalendarClock className="size-5 text-primary" />{t('strategy.enabled')}</Label>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('strategy.intro')}</p></div>
      <Switch id="strategy-enabled" checked={config.enabled} onCheckedChange={(enabled) => update({ enabled })} />
    </div>
    {!councilEnabled && config.enabled && <p role="alert" className="text-sm text-destructive">{t('strategy.needsCouncil')}</p>}
    <p className="text-xs leading-5 text-muted-foreground">{t('strategy.enableHint')}</p>
    {config.enabled && <>
      <div className="grid gap-4 sm:grid-cols-2">
        {([
          ['preOpenMinutes', 15, 240, 'preOpenMinutes'], ['monitorSeconds', 30, 900, 'monitorSeconds'],
          ['maxEventReplansPerDay', 0, 3, 'eventReplans'], ['eventReplanCooldownMinutes', 30, 1440, 'eventCooldown'],
        ] as const).map(([field, min, max, label]) => <div key={field} className="space-y-2">
          <Label htmlFor={`strategy-${field}`}>{t(`strategy.${label}`)}</Label>
          <Input id={`strategy-${field}`} type="number" min={min} max={max} step={1} value={config[field]}
            onChange={(event) => update({ [field]: Number(event.target.value) })} />
        </div>)}
      </div>
      <div className="space-y-2 rounded-lg border border-border bg-card p-3">
        <p className="text-sm font-semibold">{t('strategy.reviewer')}</p>
        <p className="break-words text-xs text-muted-foreground">{models.memberLabel(reviewer)}</p>
        <p className="text-xs leading-5 text-muted-foreground">{t('strategy.reviewerHint')}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setEditingReviewer(true)}>
          <SlidersHorizontal className="size-3.5" />{t('strategy.configureReviewer')}</Button>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div><Label htmlFor="strategy-notifications">{t('strategy.notifications')}</Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('strategy.notificationHint')}</p>
          <Link to="/paper#notifications" className="text-xs text-primary hover:underline">{t('strategy.configureNotifications')}</Link></div>
        <Switch id="strategy-notifications" checked={notifications} onCheckedChange={onNotificationsChange} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="strategy-summary">{t('strategy.closingSummary')}</Label>
        <Switch id="strategy-summary" checked={config.notifyClosingSummary} disabled={!notifications}
          onCheckedChange={(notifyClosingSummary) => update({ notifyClosingSummary })} />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t('strategy.runtimeHint')}</p>
    </>}
    {editingReviewer && <CouncilMemberEditor member={reviewer} modelOnly webResearch={false} modelOptions={models.options.filter(option => option.model === 'fast')}
      localAgents={models.localAgents} onClose={() => setEditingReviewer(false)} onSave={(member) => {
        update({ fastReviewer: { ...member, id: 'fast-reviewer', role: 'researcher', model: 'fast' } }); setEditingReviewer(false); return null;
      }} />}
  </section>;
}
