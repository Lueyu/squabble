import { useTranslation } from 'react-i18next';
import { CalendarClock, Users } from 'lucide-react';
import type { CouncilConfig, TradingCadence } from '@shared/council.interface';
import { createCouncilPreset } from '@shared/council-templates';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_CADENCE } from '@/utils/council-state';
import CouncilTeamEditor from '@/pages/Council/CouncilTeamEditor';

export function defaultCouncil(language: string): CouncilConfig {
  return { enabled: true, members: createCouncilPreset('balanced', language), webResearch: false };
}

export default function CouncilConfigEditor({ council, cadence, onCouncilChange, onCadenceChange, automationEnabled = false }: {
  council: CouncilConfig; cadence: TradingCadence;
  automationEnabled?: boolean;
  onCouncilChange: (value: CouncilConfig) => void;
  onCadenceChange: (value: TradingCadence) => void;
}) {
  const { t } = useTranslation();
  return <div className="space-y-5">
    <section className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
      <div className="flex items-start justify-between gap-4">
        <div><Label htmlFor="council-enabled" className="flex items-center gap-2 text-base font-semibold">
          <Users className="size-5 text-primary" />{t('council.team.title')}</Label>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('council.team.intro')}</p></div>
        <Switch id="council-enabled" checked={council.enabled}
          onCheckedChange={(enabled: boolean) => onCouncilChange({ ...council, enabled })} />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t(council.enabled ? 'council.team.enabledHint' : 'council.team.rulesOnly')}</p>
      {council.enabled && <CouncilTeamEditor value={council} onChange={onCouncilChange} />}
    </section>
    <section className="space-y-4 rounded-xl border border-border p-4">
      <div><h4 className="flex items-center gap-2 font-semibold"><CalendarClock className="size-5 text-primary" />
        {t('council.cadence.title')}</h4><p className="mt-2 text-sm leading-6 text-muted-foreground">{t('council.cadence.intro')}</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(Object.keys(DEFAULT_CADENCE) as Array<keyof TradingCadence>).filter(field => !automationEnabled || field !== 'reviewEveryTradingDays').map((field) => <div key={field} className="space-y-2">
          <Label htmlFor={`cadence-${field}`}>{t(`council.cadence.${field}`)}</Label>
          <Input id={`cadence-${field}`} type="number" step={field === 'maxWeeklyTurnoverPct' ? 0.1 : 1}
            min={field === 'cooldownTradingDays' ? 0 : field === 'maxWeeklyTurnoverPct' ? 0.1 : 1}
            max={field === 'maxWeeklyTurnoverPct' ? 100 : field === 'maxOrdersPerWeek' ? 20 : 60}
            value={cadence[field]} onChange={(event) => onCadenceChange({ ...cadence, [field]: Number(event.target.value) })} />
        </div>)}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t(automationEnabled ? 'strategy.cadenceHint' : 'council.cadence.calendarHint')}</p>
    </section>
  </div>;
}
