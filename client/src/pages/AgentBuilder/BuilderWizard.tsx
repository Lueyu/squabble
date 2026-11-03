import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Check, ChevronLeft, ChevronRight, Loader2, Plus, Radar,
  Shield, SlidersHorizontal, Trash2,
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';

import {
  activateBuilderProfile,
  createBuilderProfile,
  previewBuilder,
  updateBuilderProfile,
  type BuilderConfig,
  type BuilderPreview,
  type BuilderProfile,
} from '@/api/builder';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from './errorMessage';
import CouncilConfigEditor, { defaultCouncil } from './CouncilConfigEditor';
import StrategyAutomationEditor from './StrategyAutomationEditor';
import { DEFAULT_CADENCE, validateCouncilSettings } from '@/utils/council-state';

interface BuilderWizardProps {
  editing: BuilderProfile | null;
  onSaved: () => void;
  onClose: () => void;
}

type Template = BuilderConfig['template'];

const TEMPLATE_DEFAULTS: Record<Template, Pick<BuilderConfig,
  'minimumRating' | 'maxOrderPct' | 'dailyLossLimitPct' | 'maxOrdersPerDay'>> = {
  guard: { minimumRating: 'Strong Buy', maxOrderPct: 2, dailyLossLimitPct: 2, maxOrdersPerDay: 1 },
  balanced: { minimumRating: 'Buy', maxOrderPct: 4, dailyLossLimitPct: 3, maxOrdersPerDay: 1 },
  scout: { minimumRating: 'Buy', maxOrderPct: 6, dailyLossLimitPct: 4, maxOrdersPerDay: 1 },
};

const TEMPLATES: Array<{ key: Template; icon: typeof Shield }> = [
  { key: 'guard', icon: Shield },
  { key: 'balanced', icon: SlidersHorizontal },
  { key: 'scout', icon: Radar },
];

const DEFAULT_CONFIG: BuilderConfig = {
  name: '',
  template: 'balanced',
  tickers: [],
  minimumRating: 'Buy',
  customPrompt: '',
  maxOrderPct: 4,
  dailyLossLimitPct: 3,
  maxOrdersPerDay: 1,
  notifyOnProposal: true,
};

interface PriceRuleForm {
  ticker: string;
  buyAtOrBelow: string;
  sellAtOrAbove: string;
}

function formPriceRules(config: BuilderConfig | undefined): PriceRuleForm[] {
  return (config?.priceRules ?? []).map((rule) => ({
    ticker: rule.ticker,
    buyAtOrBelow: rule.buyAtOrBelow === undefined ? '' : String(rule.buyAtOrBelow),
    sellAtOrAbove: rule.sellAtOrAbove === undefined ? '' : String(rule.sellAtOrAbove),
  }));
}

function parsePriceRules(rows: PriceRuleForm[]): BuilderConfig['priceRules'] {
  return rows.map((row: PriceRuleForm) => ({
    ticker: row.ticker.trim().toUpperCase(),
    ...(row.buyAtOrBelow.trim() ? { buyAtOrBelow: Number(row.buyAtOrBelow) } : {}),
    ...(row.sellAtOrAbove.trim() ? { sellAtOrAbove: Number(row.sellAtOrAbove) } : {}),
  }));
}

function normalizeTickers(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,，]+/u)
    .map((ticker: string) => ticker.trim().toUpperCase())
    .filter((ticker: string) => ticker.length > 0)));
}

function validateConfig(config: BuilderConfig): string | null {
  if (!config.name.trim() || config.name.trim().length > 64) return 'nameInvalid';
  if (config.tickers.length > 100 || config.tickers.some((ticker: string) =>
    !/^[A-Z0-9.^-]{1,20}$/u.test(ticker))) return 'tickersInvalid';
  if (config.tickers.length > 0 && new Set([
    ...config.tickers,
    ...(config.priceRules ?? []).map((rule) => rule.ticker),
  ]).size > 100) return 'tickersInvalid';
  if (config.customPrompt.length > 2000) return 'promptInvalid';
  if (config.priceRules && config.priceRules.length > 20) return 'priceRulesInvalid';
  const priceTickers: Set<string> = new Set();
  for (const rule of config.priceRules ?? []) {
    if (!/^[A-Z0-9.^-]{1,20}$/u.test(rule.ticker)
      || priceTickers.has(rule.ticker)
      || (rule.buyAtOrBelow === undefined && rule.sellAtOrAbove === undefined)
      || (rule.buyAtOrBelow !== undefined
        && (!Number.isFinite(rule.buyAtOrBelow) || rule.buyAtOrBelow <= 0))
      || (rule.sellAtOrAbove !== undefined
        && (!Number.isFinite(rule.sellAtOrAbove) || rule.sellAtOrAbove <= 0))) {
      return 'priceRulesInvalid';
    }
    priceTickers.add(rule.ticker);
  }
  if (!Number.isFinite(config.maxOrderPct) || config.maxOrderPct <= 0 || config.maxOrderPct > 20) {
    return 'orderPctInvalid';
  }
  if (!Number.isFinite(config.dailyLossLimitPct)
    || config.dailyLossLimitPct <= 0 || config.dailyLossLimitPct > 20) {
    return 'lossPctInvalid';
  }
  if (!Number.isInteger(config.maxOrdersPerDay)
    || config.maxOrdersPerDay < 1 || config.maxOrdersPerDay > 20) {
    return 'ordersInvalid';
  }
  return null;
}

export default function BuilderWizard({ editing, onSaved, onClose }: BuilderWizardProps) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<BuilderConfig>(() => ({
    ...(editing?.config ?? { ...DEFAULT_CONFIG, name: t('ui.builder.template.balanced.defaultName') }),
    council: editing ? (editing.config.council ?? { ...defaultCouncil(i18n.language), enabled: false }) : defaultCouncil(i18n.language),
    cadence: editing?.config.cadence ?? { ...DEFAULT_CADENCE },
  }));
  const [tickerText, setTickerText] = useState(editing?.config.tickers.join(', ') ?? '');
  const [priceRows, setPriceRows] = useState<PriceRuleForm[]>(formPriceRules(editing?.config));
  const [saved, setSaved] = useState<BuilderProfile | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const previewMutation = useMutation<BuilderPreview, Error, BuilderConfig>({
    mutationFn: previewBuilder,
    retry: false,
  });

  const saveMutation = useMutation<BuilderProfile, Error,
    { activate: boolean; config: BuilderConfig }>({
    mutationFn: async ({ activate, config: nextConfig }) => {
      const profile: BuilderProfile = editing
        ? await updateBuilderProfile(editing.id, nextConfig)
        : await createBuilderProfile(nextConfig);
      setSaved(profile);
      onSaved();
      setStep(3);
      if (activate && profile.status !== 'active') {
        const active: BuilderProfile = await activateBuilderProfile(profile.id);
        setSaved(active);
        onSaved();
        return active;
      }
      return profile;
    },
    onSuccess: () => {
      setStep(3);
      toast.success(t('ui.builder.saved'));
    },
    onError: (error: Error) => {
      toast.error(errorMessage(error, t('ui.builder.saveFailed')));
    },
    retry: false,
  });

  const activateMutation = useMutation<BuilderProfile, Error, string>({
    mutationFn: activateBuilderProfile,
    onSuccess: (profile: BuilderProfile) => {
      setSaved(profile);
      onSaved();
      toast.success(t('ui.builder.activated'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.activateFailed'))),
    retry: false,
  });

  const selectTemplate = (template: Template) => {
    const defaultNames: string[] = TEMPLATES.map(({ key }) =>
      t(`ui.builder.template.${key}.defaultName`));
    setConfig((previous: BuilderConfig) => ({
      ...previous,
      template,
      ...TEMPLATE_DEFAULTS[template],
      name: !previous.name || defaultNames.includes(previous.name)
        ? t(`ui.builder.template.${template}.defaultName`)
        : previous.name,
    }));
  };

  const goToRules = () => {
    if (!config.name.trim()) {
      setFormError(t('ui.builder.nameInvalid'));
      return;
    }
    const councilInvalid = validateCouncilSettings(config.council, config.cadence);
    if (councilInvalid) {
      setFormError(t(`council.${councilInvalid}`));
      return;
    }
    if (config.automation?.enabled && !config.council?.enabled) {
      setFormError(t('strategy.needsCouncil')); return;
    }
    setFormError(null);
    setStep(1);
  };

  const goToPreview = async () => {
    const nextConfig: BuilderConfig = {
      ...config,
      language: i18n.language.startsWith('zh') ? 'zh-CN' : 'en',
      name: config.name.trim(),
      tickers: normalizeTickers(tickerText),
      priceRules: parsePriceRules(priceRows),
      customPrompt: config.customPrompt.trim(),
    };
    const invalid: string | null = validateConfig(nextConfig);
    if (invalid) {
      setFormError(t(`ui.builder.${invalid}`));
      return;
    }
    const councilInvalid = validateCouncilSettings(nextConfig.council, nextConfig.cadence);
    if (councilInvalid) {
      setFormError(t(`council.${councilInvalid}`));
      return;
    }
    setFormError(null);
    setConfig(nextConfig);
    try {
      await previewMutation.mutateAsync(nextConfig);
      setStep(2);
    } catch (error) {
      toast.error(errorMessage(error, t('ui.builder.previewFailed')));
    }
  };

  const updatePriceRow = (index: number, field: keyof PriceRuleForm, value: string) => {
    setPriceRows((previous: PriceRuleForm[]) => previous.map((row: PriceRuleForm, rowIndex: number) =>
      rowIndex === index ? { ...row, [field]: value } : row));
  };

  const stepLabels: string[] = [
    t('ui.builder.stepTemplate'),
    t('ui.builder.stepRules'),
    t('ui.builder.stepPreview'),
  ];

  return (
    <Card className="overflow-hidden border-primary/30">
      <CardHeader className="border-b border-border bg-muted/30">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              {editing ? t('ui.builder.editAgent') : t('ui.builder.newAgent')}
            </p>
            <CardTitle className="mt-2 font-serif text-xl">{t('ui.builder.wizardTitle')}</CardTitle>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('ui.builder.close')}
          </Button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2" aria-label={t('ui.builder.progress')}>
          {stepLabels.map((label: string, index: number) => (
            <div key={label} className="min-w-0">
              <div className={`h-1 rounded-full ${index <= step ? 'bg-primary' : 'bg-border'}`} />
              <p className={`mt-2 truncate text-xs ${index === step ? 'font-semibold' : 'text-muted-foreground'}`}>
                {index + 1}. {label}
              </p>
            </div>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        {step === 0 && (
          <>
            <div>
              <h3 className="text-lg font-semibold">{t('ui.builder.chooseTemplate')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.templateHint')}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {TEMPLATES.map(({ key, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={config.template === key}
                  onClick={() => selectTemplate(key)}
                  className={`rounded-xl border p-4 text-left transition-colors hover:border-primary/60 ${
                    config.template === key ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <span className="flex items-center justify-between">
                    <Icon className="size-5 text-primary" />
                    {config.template === key && <Check className="size-4 text-primary" />}
                  </span>
                  <span className="mt-4 block font-semibold">{t(`ui.builder.template.${key}.title`)}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {t(`ui.builder.template.${key}.description`)}
                  </span>
                </button>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="builder-name">{t('ui.builder.name')}</Label>
              <Input id="builder-name" maxLength={64} value={config.name}
                placeholder={t('ui.builder.namePlaceholder')}
                onChange={(event) => setConfig({ ...config, name: event.target.value })} />
            </div>
            <CouncilConfigEditor council={config.council ?? defaultCouncil(i18n.language)}
              automationEnabled={config.automation?.enabled}
              cadence={config.cadence ?? DEFAULT_CADENCE}
              onCouncilChange={(council) => setConfig({ ...config, council })}
              onCadenceChange={(cadence) => setConfig({ ...config, cadence })} />
            <StrategyAutomationEditor value={config.automation} councilEnabled={Boolean(config.council?.enabled)}
              notifications={config.notifyOnProposal} onChange={(automation) => setConfig({ ...config, automation })}
              onNotificationsChange={(notifyOnProposal) => setConfig({ ...config, notifyOnProposal })} />
            <div className="flex justify-end">
              <Button type="button" onClick={goToRules}>
                {t('ui.builder.next')} <ChevronRight />
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div>
              <h3 className="text-lg font-semibold">{t('ui.builder.setRules')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.rulesHint')}</p>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="builder-tickers">{t('ui.builder.tickers')}</Label>
                <Input id="builder-tickers" value={tickerText}
                  placeholder={t('ui.builder.tickersPlaceholder')}
                  onChange={(event) => setTickerText(event.target.value)} />
                <p className="text-xs text-muted-foreground">{t('ui.builder.tickersHint')}</p>
              </div>
              {!config.automation?.enabled && <div className="space-y-3 rounded-xl border border-border p-4 md:col-span-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold">{t('ui.builder.priceRules')}</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t('ui.builder.priceRulesHint')}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline"
                    disabled={priceRows.length >= 20}
                    onClick={() => setPriceRows((previous: PriceRuleForm[]) => [
                      ...previous, { ticker: '', buyAtOrBelow: '', sellAtOrAbove: '' },
                    ])}>
                    <Plus /> {t('ui.builder.addPriceRule')}
                  </Button>
                </div>
                {priceRows.map((row: PriceRuleForm, index: number) => (
                  <div key={index} className="grid gap-3 rounded-lg bg-muted/40 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <div className="space-y-2">
                      <Label htmlFor={`builder-price-ticker-${index}`}>{t('ui.builder.ruleTicker')}</Label>
                      <Input id={`builder-price-ticker-${index}`} value={row.ticker} maxLength={20}
                        placeholder="AAPL"
                        onChange={(event) => updatePriceRow(index, 'ticker', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`builder-price-buy-${index}`}>{t('ui.builder.buyAtOrBelow')}</Label>
                      <Input id={`builder-price-buy-${index}`} type="number" min="0.000001" step="any"
                        value={row.buyAtOrBelow} placeholder={t('ui.builder.optional')}
                        onChange={(event) => updatePriceRow(index, 'buyAtOrBelow', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`builder-price-sell-${index}`}>{t('ui.builder.sellAtOrAbove')}</Label>
                      <Input id={`builder-price-sell-${index}`} type="number" min="0.000001" step="any"
                        value={row.sellAtOrAbove} placeholder={t('ui.builder.optional')}
                        onChange={(event) => updatePriceRow(index, 'sellAtOrAbove', event.target.value)} />
                    </div>
                    <Button type="button" size="icon" variant="ghost" className="self-end"
                      aria-label={t('ui.builder.removePriceRule')}
                      onClick={() => setPriceRows((previous: PriceRuleForm[]) =>
                        previous.filter((_: PriceRuleForm, rowIndex: number) => rowIndex !== index))}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>}
              {!config.automation?.enabled && <div className="space-y-2">
                <Label htmlFor="builder-rating">{t('ui.builder.minimumRating')}</Label>
                <select id="builder-rating" value={config.minimumRating}
                  onChange={(event) => setConfig({ ...config,
                    minimumRating: event.target.value === 'Strong Buy' ? 'Strong Buy' : 'Buy' })}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="Buy">{t('ui.builder.ratingBuy')}</option>
                  <option value="Strong Buy">{t('ui.builder.ratingStrongBuy')}</option>
                </select>
              </div>}
              <NumberField id="builder-order-pct" label={t('ui.builder.maxOrderPct')}
                value={config.maxOrderPct} min={0.1} max={20} step={0.1}
                onChange={(value: number) => setConfig({ ...config, maxOrderPct: value })} />
              <NumberField id="builder-loss-pct" label={t('ui.builder.dailyLossLimitPct')}
                value={config.dailyLossLimitPct} min={0.1} max={20} step={0.1}
                onChange={(value: number) => setConfig({ ...config, dailyLossLimitPct: value })} />
              <NumberField id="builder-order-count" label={t('ui.builder.maxOrdersPerDay')}
                value={config.maxOrdersPerDay} min={1} max={20} step={1}
                onChange={(value: number) => setConfig({ ...config, maxOrdersPerDay: value })} />
              {config.automation?.enabled && <p className="text-xs leading-5 text-muted-foreground md:col-span-2">{t('strategy.riskHint')}</p>}
              <div className="flex items-center justify-between rounded-lg border border-border p-4 md:col-span-2">
                <div>
                  <Label htmlFor="builder-notify">{t(config.automation?.enabled ? 'strategy.notifications' : 'ui.builder.notifyOnProposal')}</Label>
                  <p className="mt-1 text-xs text-muted-foreground">{t('ui.builder.notifyHint')}</p>
                </div>
                <Switch id="builder-notify" checked={config.notifyOnProposal}
                  onCheckedChange={(checked: boolean) => setConfig({ ...config, notifyOnProposal: checked })} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="builder-prompt">{t('ui.builder.customPrompt')}</Label>
                <Textarea id="builder-prompt" rows={4} value={config.customPrompt}
                  maxLength={2000} placeholder={t('ui.builder.promptPlaceholder')}
                  onChange={(event) => setConfig({ ...config, customPrompt: event.target.value })} />
                <p className="text-xs text-muted-foreground">
                  {t('ui.builder.promptHint')}{' '}
                  <Link to="/settings" className="font-medium text-primary underline-offset-4 hover:underline">
                    {t('ui.builder.openApiSettings')}
                  </Link>
                </p>
              </div>
            </div>
            <div className="flex justify-between gap-3">
              <Button type="button" variant="outline" onClick={() => setStep(0)}>
                <ChevronLeft /> {t('ui.builder.back')}
              </Button>
              <Button type="button" onClick={() => void goToPreview()}
                disabled={previewMutation.isPending}>
                {previewMutation.isPending && <Loader2 className="animate-spin" />}
                {t('ui.builder.previewBehavior')} <ChevronRight />
              </Button>
            </div>
          </>
        )}

        {step === 2 && previewMutation.data && (
          <>
            <div>
              <h3 className="text-lg font-semibold">{t('ui.builder.previewTitle')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.previewHint')}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {previewMutation.data.scenarios.map((scenario) => (
                <div key={scenario.key} className="rounded-lg border border-border p-4">
                  <span className={`text-xs font-semibold uppercase tracking-wide ${
                    scenario.result === 'paper' ? 'text-emerald-600 dark:text-emerald-400'
                      : scenario.result === 'block' ? 'text-rose-600 dark:text-rose-400'
                        : 'text-amber-600 dark:text-amber-400'
                  }`}>{t(`ui.builder.previewResult.${scenario.result}`)}</span>
                  <p className="mt-2 font-medium">{t(`ui.builder.scenario.${scenario.key}`, {
                    defaultValue: scenario.key,
                  })}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(`ui.builder.scenarioExplanation.${scenario.key}`, {
                      defaultValue: scenario.explanation,
                      maxOrderPct: config.maxOrderPct,
                      dailyLossLimitPct: config.dailyLossLimitPct,
                    })}
                  </p>
                </div>
              ))}
            </div>
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              {t('ui.builder.paperOnlyNotice')}
            </p>
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-6">
              {config.automation?.enabled && <div className="mb-3 border-b border-border pb-3">
                <p className="font-semibold">{t('strategy.preview')}</p>
                <p className="mt-1 text-muted-foreground">{t('strategy.previewHint')}</p>
              </div>}
              <p>{t(config.council?.enabled ? 'council.team.enabledHint' : 'council.team.rulesOnly')}</p>
              <p className="mt-2 text-muted-foreground">{t(config.automation?.enabled ? 'strategy.cadenceSummary' : 'council.cadence.summary', {
                days: config.cadence?.reviewEveryTradingDays ?? DEFAULT_CADENCE.reviewEveryTradingDays,
                orders: config.cadence?.maxOrdersPerWeek ?? DEFAULT_CADENCE.maxOrdersPerWeek,
              })}</p>
            </div>
            {config.customPrompt && (
              <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                {t('ui.builder.modelNotice')}{' '}
                <Link to="/settings" className="font-medium text-primary underline-offset-4 hover:underline">
                  {t('ui.builder.openApiSettings')}
                </Link>
              </p>
            )}
            <div className="flex flex-wrap justify-between gap-3">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                <ChevronLeft /> {t('ui.builder.back')}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ activate: false, config })}>
                  {t(editing ? 'ui.builder.saveDraft' : 'ui.builder.createDraft')}
                </Button>
                <Button type="button" disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ activate: true, config })}>
                  {saveMutation.isPending && <Loader2 className="animate-spin" />}
                  {t(editing ? 'ui.builder.saveAndActivate' : 'ui.builder.createAndActivate')}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === 3 && saved && (
          <div className="space-y-5 py-4 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
              <Check className="size-6" />
            </div>
            <div>
              <h3 className="font-serif text-xl font-semibold">{t('ui.builder.readyTitle')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('ui.builder.readyDescription', { name: saved.config.name })}
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              <Button asChild variant="outline"><Link to={`/council?profileId=${encodeURIComponent(saved.id)}`}>
                {t('council.open')}</Link></Button>
              {saved.status !== 'active' && (
                <Button type="button" onClick={() => activateMutation.mutate(saved.id)}
                  disabled={activateMutation.isPending}>
                  {t('ui.builder.activate')}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                {t('ui.builder.done')}
              </Button>
            </div>
          </div>
        )}

        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
      </CardContent>
    </Card>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function NumberField({ id, label, value, min, max, step, onChange }: NumberFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={min} max={max} step={step} value={value}
        onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}
