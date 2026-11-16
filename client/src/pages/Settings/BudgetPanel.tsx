import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Loader2, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import type { LlmBudgetSettings } from '@shared/council.interface';
import { fetchLlmBudgetUsage, saveLlmBudget } from '@/api/council';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { budgetPercent, validateBudget } from '@/utils/council-state';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

export default function BudgetPanel() {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const query = useQuery({
    queryKey: ['llm-budget', 'usage'],
    queryFn: fetchLlmBudgetUsage,
    refetchInterval: 30_000,
  });
  const usage = query.data;
  const client = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => saveLlmBudget({ ...usage!.settings, enabled }),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: ['llm-budget'] });
    },
    onError: (cause: Error) => toast.error(errorMessage(cause, t('council.saveFailed'))),
  });
  const number = (value: number) => value.toLocaleString(i18n.language);
  return (
    <Card id="research-budget" className="min-w-0 scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 font-serif text-xl">
              <Coins className="size-5 text-primary" />
              {t('council.budget.title')}
            </CardTitle>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t('council.budget.intro')}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!usage || !usage.settings.enabled}
            onClick={() => setEditing(!editing)}
            aria-expanded={editing}
          >
            <Settings2 />
            {t(editing ? 'council.close' : 'council.budget.edit')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {usage && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-muted/30 p-4">
            <div className="min-w-0">
              <Label htmlFor="budget-enabled" className="font-semibold">
                {t('council.budget.enabled')}
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t(
                  usage.settings.enabled
                    ? 'council.budget.enabledHint'
                    : 'council.budget.disabledHint',
                )}
              </p>
            </div>
            <Switch
              id="budget-enabled"
              checked={usage.settings.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(enabled: boolean) => toggle.mutate(enabled)}
              aria-label={t('council.budget.enabled')}
            />
          </div>
        )}
        {query.isLoading && <p className="text-sm text-muted-foreground">{t('council.loading')}</p>}
        {query.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            {errorMessage(query.error, t('council.loadFailed'))}
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t('council.retry')}
            </Button>
          </div>
        )}
        {usage && (
          <>
            <div
              className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4"
              data-ai-section-type="card-stat"
            >
              <BudgetMeter
                label={t('council.budget.today')}
                used={usage.dayTokens}
                limit={usage.settings.enabled ? usage.settings.dailyTokenLimit : null}
                number={number}
              />
              <BudgetMeter
                label={t('council.budget.month')}
                used={usage.monthTokens}
                limit={usage.settings.enabled ? usage.settings.monthlyTokenLimit : null}
                number={number}
              />
              <BudgetMeter
                label={t('council.budget.calls')}
                used={usage.dayCalls}
                limit={usage.settings.enabled ? usage.settings.dailyCallLimit : null}
                number={number}
              />
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t('council.budget.estimatedCost')}</p>
                <p className="font-mono text-xl font-semibold">
                  {usage.estimatedCostUsd === null
                    ? t('council.budget.unknown')
                    : `$${usage.estimatedCostUsd.toFixed(4)}`}
                </p>
                <p className="text-xs text-muted-foreground">{t('council.budget.estimateHint')}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {t('council.budget.reserved', { count: usage.reservedTokens })}
                </Badge>
                <span className="self-center">{t('council.budget.utc')}</span>
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t('council.budget.accountingHint')}
            </p>
            {editing && usage.settings.enabled && (
              <BudgetEditor
                key={JSON.stringify(usage.settings)}
                settings={usage.settings}
                onSaved={() => setEditing(false)}
              />
            )}
            {usage.recent.length > 0 && (
              <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {t('council.budget.recent')}
                </summary>
                <div className="mt-3 max-w-full overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="p-2">{t('council.budget.purpose')}</th>
                        <th className="p-2">{t('council.model')}</th>
                        <th className="p-2">{t('council.budget.tokens')}</th>
                        <th className="p-2">{t('council.state')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.recent.slice(0, 10).map((call) => (
                        <tr key={call.id} className="border-t border-border">
                          <td className="max-w-48 break-words p-2">
                            {t(`council.budget.purposes.${call.purpose}`, {
                              defaultValue: call.purpose,
                              nsSeparator: false,
                            })}
                          </td>
                          <td className="max-w-40 break-words p-2 font-mono">{call.model}</td>
                          <td className="whitespace-nowrap p-2">{number(call.chargedTokens)}</td>
                          <td className="p-2">
                            {t(`council.budget.status.${call.status}`, {
                              defaultValue: call.status,
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BudgetMeter({
  label,
  used,
  limit,
  number,
}: {
  label: string;
  used: number;
  limit: number | null;
  number: (value: number) => string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-xl font-semibold">
        {number(used)}
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          / {limit === null ? t('council.budget.unlimited') : number(limit)}
        </span>
      </p>
      {limit !== null && <Progress value={budgetPercent(used, limit)} aria-label={label} />}
    </div>
  );
}

const CAP_FIELDS = [
  'dailyTokenLimit',
  'monthlyTokenLimit',
  'perTaskTokenLimit',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCallsPerTask',
  'dailyCallLimit',
] as const;
const PRICE_FIELDS: Array<'inputUsdPerMillion' | 'outputUsdPerMillion'> = [
  'inputUsdPerMillion',
  'outputUsdPerMillion',
];

function BudgetEditor({ settings, onSaved }: { settings: LlmBudgetSettings; onSaved: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [draft, setDraft] = useState<LlmBudgetSettings>(settings);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: saveLlmBudget,
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['llm-budget'] });
      toast.success(t('council.budget.saved'));
      onSaved();
    },
    onError: (cause: Error) => toast.error(errorMessage(cause, t('council.saveFailed'))),
  });
  return (
    <form
      className="space-y-4 rounded-xl bg-muted/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const invalid = validateBudget(draft);
        setError(invalid);
        if (!invalid) save.mutate(draft);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CAP_FIELDS.map((field) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`budget-${field}`}>{t(`council.budget.fields.${field}`)}</Label>
            <Input
              id={`budget-${field}`}
              type="number"
              min={1}
              step={1}
              required
              value={draft[field] ?? ''}
              onChange={(event) => setDraft({ ...draft, [field]: Number(event.target.value) })}
            />
          </div>
        ))}
        {PRICE_FIELDS.map((field) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`budget-${field}`}>{t(`council.budget.fields.${field}`)}</Label>
            <Input
              id={`budget-${field}`}
              type="number"
              min={0}
              max={100000}
              step="any"
              placeholder={t('council.budget.optionalPrice')}
              value={draft[field] ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  [field]: event.target.value.trim() === '' ? null : Number(event.target.value),
                })
              }
            />
          </div>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t('council.budget.limitHint')}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`council.budget.${error}`)}
        </p>
      )}
      <Button type="submit" disabled={save.isPending}>
        {save.isPending && <Loader2 className="animate-spin" />}
        {t('council.budget.save')}
      </Button>
    </form>
  );
}
