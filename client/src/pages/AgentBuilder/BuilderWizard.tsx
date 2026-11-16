/**
 * BuilderWizard.tsx — 智能体构建向导：三步（选模板 → 设规则 → 行为预览）+ 保存完成页。
 *
 * 职责边界：
 *  - 步骤 0：选三模板之一（guard/balanced/scout，选中即套用参数默认值）、命名、投委会配置；
 *  - 步骤 1：标的池、个股价格规则（≤买价/≥卖价，上限 20 条）、最低评级、单笔/日内风控参数、
 *    提案通知开关、自定义提示词；
 *  - 步骤 2：调用 previewBuilder 展示行为预览（paper/block/ask 场景），提供"仅保存草稿"与
 *    "保存并激活"两个提交入口；
 *  - 步骤 3：完成页（保存成功后可跳投委会/激活/关闭）。
 * 上下游：
 *  - 上游（路由入口/谁引用）：AgentBuilderPage（向导开关状态，key=编辑对象 id 或 'new'）。
 *  - 下游（调用哪些 hooks/api/组件）：@/api/builder 的 previewBuilder/createBuilderProfile/
 *    updateBuilderProfile/activateBuilderProfile；本目录 errorMessage；CouncilConfigEditor
 *    （含 defaultCouncil 工厂）；@/utils/council-state 的 DEFAULT_CADENCE/validateCouncilSettings；
 *    toast；Button/Card/Input/Label/Textarea/Switch。
 * 关键约定：
 *  - 步骤 0/1 之间校验名称与投委会设置；步骤 1→2 前做完整 validateConfig（含去重后的标的池、
 *    价格规则合法性、风控参数范围）并请求服务端预览，成功才进入步骤 2。
 *  - 保存 mutationFn 内联完成"保存→（可选激活）"两步，中途 setSaved/setStep(3) 保证 UI 先行反馈。
 *  - 模板切换只在当前名称为空或等于任一模板默认名时才覆盖默认名（保留用户自定义名）。
 *  - 提交时补充 language 字段（zh 前缀 → zh-CN，否则 en）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Radar,
  Shield,
  SlidersHorizontal,
  Trash2,
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
import { DEFAULT_CADENCE, validateCouncilSettings } from '@/utils/council-state';

// 向导入参：editing=null 为新建模式；onSaved 通知父级刷新；onClose 关闭向导
interface BuilderWizardProps {
  editing: BuilderProfile | null;
  onSaved: () => void;
  onClose: () => void;
}

// 模板 key：guard（保守）/ balanced（均衡）/ scout（探索）
type Template = BuilderConfig['template'];

// 三模板的参数默认值：最低评级 / 单笔上限% / 日亏上限% / 日内笔数
const TEMPLATE_DEFAULTS: Record<
  Template,
  Pick<BuilderConfig, 'minimumRating' | 'maxOrderPct' | 'dailyLossLimitPct' | 'maxOrdersPerDay'>
> = {
  guard: { minimumRating: 'Strong Buy', maxOrderPct: 2, dailyLossLimitPct: 2, maxOrdersPerDay: 1 },
  balanced: { minimumRating: 'Buy', maxOrderPct: 4, dailyLossLimitPct: 3, maxOrdersPerDay: 1 },
  scout: { minimumRating: 'Buy', maxOrderPct: 6, dailyLossLimitPct: 4, maxOrdersPerDay: 1 },
};

// 模板卡片清单（key + 图标组件）
const TEMPLATES: Array<{ key: Template; icon: typeof Shield }> = [
  { key: 'guard', icon: Shield },
  { key: 'balanced', icon: SlidersHorizontal },
  { key: 'scout', icon: Radar },
];

// 新建时的空白配置（均衡模板默认值 + 提案通知开）
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

// 价格规则行表单：数值以字符串承载输入，提交前统一转数字
interface PriceRuleForm {
  ticker: string;
  buyAtOrBelow: string;
  sellAtOrAbove: string;
}

// 服务端价格规则 → 表单行（未设的阈值以空串表示）
function formPriceRules(config: BuilderConfig | undefined): PriceRuleForm[] {
  return (config?.priceRules ?? []).map((rule) => ({
    ticker: rule.ticker,
    buyAtOrBelow: rule.buyAtOrBelow === undefined ? '' : String(rule.buyAtOrBelow),
    sellAtOrAbove: rule.sellAtOrAbove === undefined ? '' : String(rule.sellAtOrAbove),
  }));
}

// 表单行 → 服务端价格规则：ticker 去空格转大写，空串阈值不出现在结果里（条件展开）
function parsePriceRules(rows: PriceRuleForm[]): BuilderConfig['priceRules'] {
  return rows.map((row: PriceRuleForm) => ({
    ticker: row.ticker.trim().toUpperCase(),
    ...(row.buyAtOrBelow.trim() ? { buyAtOrBelow: Number(row.buyAtOrBelow) } : {}),
    ...(row.sellAtOrAbove.trim() ? { sellAtOrAbove: Number(row.sellAtOrAbove) } : {}),
  }));
}

// 标的池文本 → 去重后的代码数组：按空白/中英文逗号切分，去空格转大写，滤空
function normalizeTickers(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,，]+/u)
        .map((ticker: string) => ticker.trim().toUpperCase())
        .filter((ticker: string) => ticker.length > 0),
    ),
  );
}

// 完整配置校验：返回 i18n key（ui.builder.*）或 null=通过。
// 依次检查：名称（1-64 字）→ 标的池（≤100 且每个匹配 ^[A-Z0-9.^-]{1,20}$，
// 与价格规则合并去重后仍 ≤100）→ 提示词 ≤2000 → 价格规则 ≤20 条且每条
// ticker 合法、不重复、至少设一个阈值、阈值必须为正有限数 →
// maxOrderPct (0,20] → dailyLossLimitPct (0,20] → maxOrdersPerDay 整数 [1,20]。
function validateConfig(config: BuilderConfig): string | null {
  if (!config.name.trim() || config.name.trim().length > 64) return 'nameInvalid';
  if (
    config.tickers.length > 100 ||
    config.tickers.some((ticker: string) => !/^[A-Z0-9.^-]{1,20}$/u.test(ticker))
  )
    return 'tickersInvalid';
  if (
    config.tickers.length > 0 &&
    new Set([...config.tickers, ...(config.priceRules ?? []).map((rule) => rule.ticker)]).size > 100
  )
    return 'tickersInvalid';
  if (config.customPrompt.length > 2000) return 'promptInvalid';
  if (config.priceRules && config.priceRules.length > 20) return 'priceRulesInvalid';
  const priceTickers: Set<string> = new Set();
  for (const rule of config.priceRules ?? []) {
    if (
      !/^[A-Z0-9.^-]{1,20}$/u.test(rule.ticker) ||
      priceTickers.has(rule.ticker) ||
      (rule.buyAtOrBelow === undefined && rule.sellAtOrAbove === undefined) ||
      (rule.buyAtOrBelow !== undefined &&
        (!Number.isFinite(rule.buyAtOrBelow) || rule.buyAtOrBelow <= 0)) ||
      (rule.sellAtOrAbove !== undefined &&
        (!Number.isFinite(rule.sellAtOrAbove) || rule.sellAtOrAbove <= 0))
    ) {
      return 'priceRulesInvalid';
    }
    priceTickers.add(rule.ticker);
  }
  if (!Number.isFinite(config.maxOrderPct) || config.maxOrderPct <= 0 || config.maxOrderPct > 20) {
    return 'orderPctInvalid';
  }
  if (
    !Number.isFinite(config.dailyLossLimitPct) ||
    config.dailyLossLimitPct <= 0 ||
    config.dailyLossLimitPct > 20
  ) {
    return 'lossPctInvalid';
  }
  if (
    !Number.isInteger(config.maxOrdersPerDay) ||
    config.maxOrdersPerDay < 1 ||
    config.maxOrdersPerDay > 20
  ) {
    return 'ordersInvalid';
  }
  return null;
}

export default function BuilderWizard({ editing, onSaved, onClose }: BuilderWizardProps) {
  // —— 状态声明区 ——
  const { t, i18n } = useTranslation();
  // 当前步骤：0 模板 / 1 规则 / 2 预览 / 3 完成
  const [step, setStep] = useState(0);
  // 配置初值：编辑模式沿用档案配置；新建用默认配置+当前语言默认名。
  // council/cadence 两段单独兜底（编辑对象缺省时补默认值；编辑模式 council 默认 enabled:false）
  const [config, setConfig] = useState<BuilderConfig>(() => ({
    ...(editing?.config ?? {
      ...DEFAULT_CONFIG,
      name: t('ui.builder.template.balanced.defaultName'),
    }),
    council: editing
      ? (editing.config.council ?? { ...defaultCouncil(i18n.language), enabled: false })
      : defaultCouncil(i18n.language),
    cadence: editing?.config.cadence ?? { ...DEFAULT_CADENCE },
  }));
  // 标的池以原始文本承载（逗号/空格分隔，提交时才规范化）
  const [tickerText, setTickerText] = useState(editing?.config.tickers.join(', ') ?? '');
  // 价格规则行表单
  const [priceRows, setPriceRows] = useState<PriceRuleForm[]>(formPriceRules(editing?.config));
  // 已保存档案（步骤 3 完成页展示/激活用）与表单错误文案
  const [saved, setSaved] = useState<BuilderProfile | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // —— 数据获取区 ——
  // 行为预览请求：进入步骤 2 前必须成功
  const previewMutation = useMutation<BuilderPreview, Error, BuilderConfig>({
    mutationFn: previewBuilder,
    retry: false,
  });

  // 保存：mutationFn 内联"保存 →（可选激活）"两步；中途 setSaved/setStep(3) 先行反馈，
  // 激活成功后用激活返回值覆盖 saved
  const saveMutation = useMutation<
    BuilderProfile,
    Error,
    { activate: boolean; config: BuilderConfig }
  >({
    mutationFn: async ({ activate, config: nextConfig }) => {
      // 步骤 1：编辑模式更新、新建模式创建
      const profile: BuilderProfile = editing
        ? await updateBuilderProfile(editing.id, nextConfig)
        : await createBuilderProfile(nextConfig);
      setSaved(profile);
      onSaved();
      setStep(3);
      // 步骤 2：勾选激活且当前非 active 时追加激活请求
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
  // 完成页的"激活"按钮：对未激活的已保存档案补激活
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

  // —— 事件处理区 ——
  // 选模板：套用该模板参数默认值；当前名称为空或等于任一模板默认名时才覆盖默认名
  const selectTemplate = (template: Template) => {
    const defaultNames: string[] = TEMPLATES.map(({ key }) =>
      t(`ui.builder.template.${key}.defaultName`),
    );
    setConfig((previous: BuilderConfig) => ({
      ...previous,
      template,
      ...TEMPLATE_DEFAULTS[template],
      name:
        !previous.name || defaultNames.includes(previous.name)
          ? t(`ui.builder.template.${template}.defaultName`)
          : previous.name,
    }));
  };

  // 步骤 0 → 1：名称必填 + 投委会设置校验，通过才前进
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
    setFormError(null);
    setStep(1);
  };

  // 步骤 1 → 2：组装最终配置（补 language、规范化各字段）→ 完整校验 → 投委会校验
  // → 请求服务端预览，成功才进入步骤 2；预览失败 toast
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

  // 更新价格规则行某字段（函数式更新，按行号定位）
  const updatePriceRow = (index: number, field: keyof PriceRuleForm, value: string) => {
    setPriceRows((previous: PriceRuleForm[]) =>
      previous.map((row: PriceRuleForm, rowIndex: number) =>
        rowIndex === index ? { ...row, [field]: value } : row,
      ),
    );
  };

  // —— 派生计算区 ——
  // 三个步骤标签（进度条渲染用）
  const stepLabels: string[] = [
    t('ui.builder.stepTemplate'),
    t('ui.builder.stepRules'),
    t('ui.builder.stepPreview'),
  ];

  // —— 渲染区 ——
  return (
    <Card className="overflow-hidden border-primary/30">
      <CardHeader className="border-b border-border bg-muted/30">
        <div className="flex items-start justify-between gap-4">
          <div>
            {/* 眉题：编辑模式/新建模式 */}
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              {editing ? t('ui.builder.editAgent') : t('ui.builder.newAgent')}
            </p>
            <CardTitle className="mt-2 font-serif text-xl">{t('ui.builder.wizardTitle')}</CardTitle>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('ui.builder.close')}
          </Button>
        </div>
        {/* 三段进度条：已过/当前步骤填主色 */}
        <div className="mt-5 grid grid-cols-3 gap-2" aria-label={t('ui.builder.progress')}>
          {stepLabels.map((label: string, index: number) => (
            <div key={label} className="min-w-0">
              <div className={`h-1 rounded-full ${index <= step ? 'bg-primary' : 'bg-border'}`} />
              <p
                className={`mt-2 truncate text-xs ${index === step ? 'font-semibold' : 'text-muted-foreground'}`}
              >
                {index + 1}. {label}
              </p>
            </div>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        {/* —— 步骤 0：选模板 + 命名 + 投委会配置 —— */}
        {step === 0 && (
          <>
            <div>
              <h3 className="text-lg font-semibold">{t('ui.builder.chooseTemplate')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.templateHint')}</p>
            </div>
            {/* 三个模板卡：aria-pressed 标记选中，选中卡高亮描边 + 对勾 */}
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
                  <span className="mt-4 block font-semibold">
                    {t(`ui.builder.template.${key}.title`)}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {t(`ui.builder.template.${key}.description`)}
                  </span>
                </button>
              ))}
            </div>
            {/* 智能体名称：最长 64 字 */}
            <div className="space-y-2">
              <Label htmlFor="builder-name">{t('ui.builder.name')}</Label>
              <Input
                id="builder-name"
                maxLength={64}
                value={config.name}
                placeholder={t('ui.builder.namePlaceholder')}
                onChange={(event) => setConfig({ ...config, name: event.target.value })}
              />
            </div>
            {/* 投委会配置（CouncilConfigEditor 受控组件，council/cadence 缺省时给默认值） */}
            <CouncilConfigEditor
              council={config.council ?? defaultCouncil(i18n.language)}
              cadence={config.cadence ?? DEFAULT_CADENCE}
              onCouncilChange={(council) => setConfig({ ...config, council })}
              onCadenceChange={(cadence) => setConfig({ ...config, cadence })}
            />
            <div className="flex justify-end">
              <Button type="button" onClick={goToRules}>
                {t('ui.builder.next')} <ChevronRight />
              </Button>
            </div>
          </>
        )}

        {/* —— 步骤 1：标的池 + 价格规则 + 风控参数 + 提示词 —— */}
        {step === 1 && (
          <>
            <div>
              <h3 className="text-lg font-semibold">{t('ui.builder.setRules')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.rulesHint')}</p>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              {/* 标的池：逗号/空格分隔文本，提交时规范化 */}
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="builder-tickers">{t('ui.builder.tickers')}</Label>
                <Input
                  id="builder-tickers"
                  value={tickerText}
                  placeholder={t('ui.builder.tickersPlaceholder')}
                  onChange={(event) => setTickerText(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t('ui.builder.tickersHint')}</p>
              </div>
              {/* 个股价格规则：≤买价 / ≥卖价，最多 20 行 */}
              <div className="space-y-3 rounded-xl border border-border p-4 md:col-span-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold">{t('ui.builder.priceRules')}</h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t('ui.builder.priceRulesHint')}
                    </p>
                  </div>
                  {/* 什么时候走到这里：已达 20 行上限时新增按钮禁用 */}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={priceRows.length >= 20}
                    onClick={() =>
                      setPriceRows((previous: PriceRuleForm[]) => [
                        ...previous,
                        { ticker: '', buyAtOrBelow: '', sellAtOrAbove: '' },
                      ])
                    }
                  >
                    <Plus /> {t('ui.builder.addPriceRule')}
                  </Button>
                </div>
                {priceRows.map((row: PriceRuleForm, index: number) => (
                  <div
                    key={index}
                    className="grid gap-3 rounded-lg bg-muted/40 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
                  >
                    <div className="space-y-2">
                      <Label htmlFor={`builder-price-ticker-${index}`}>
                        {t('ui.builder.ruleTicker')}
                      </Label>
                      <Input
                        id={`builder-price-ticker-${index}`}
                        value={row.ticker}
                        maxLength={20}
                        placeholder="AAPL"
                        onChange={(event) => updatePriceRow(index, 'ticker', event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`builder-price-buy-${index}`}>
                        {t('ui.builder.buyAtOrBelow')}
                      </Label>
                      <Input
                        id={`builder-price-buy-${index}`}
                        type="number"
                        min="0.000001"
                        step="any"
                        value={row.buyAtOrBelow}
                        placeholder={t('ui.builder.optional')}
                        onChange={(event) =>
                          updatePriceRow(index, 'buyAtOrBelow', event.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`builder-price-sell-${index}`}>
                        {t('ui.builder.sellAtOrAbove')}
                      </Label>
                      <Input
                        id={`builder-price-sell-${index}`}
                        type="number"
                        min="0.000001"
                        step="any"
                        value={row.sellAtOrAbove}
                        placeholder={t('ui.builder.optional')}
                        onChange={(event) =>
                          updatePriceRow(index, 'sellAtOrAbove', event.target.value)
                        }
                      />
                    </div>
                    {/* 行删除按钮（按行号过滤） */}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="self-end"
                      aria-label={t('ui.builder.removePriceRule')}
                      onClick={() =>
                        setPriceRows((previous: PriceRuleForm[]) =>
                          previous.filter(
                            (_: PriceRuleForm, rowIndex: number) => rowIndex !== index,
                          ),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
              {/* 最低评级下拉：仅 Buy / Strong Buy 两档 */}
              <div className="space-y-2">
                <Label htmlFor="builder-rating">{t('ui.builder.minimumRating')}</Label>
                <select
                  id="builder-rating"
                  value={config.minimumRating}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      minimumRating: event.target.value === 'Strong Buy' ? 'Strong Buy' : 'Buy',
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="Buy">{t('ui.builder.ratingBuy')}</option>
                  <option value="Strong Buy">{t('ui.builder.ratingStrongBuy')}</option>
                </select>
              </div>
              {/* 三个风控数字字段：单笔上限% / 日亏上限% / 日内笔数 */}
              <NumberField
                id="builder-order-pct"
                label={t('ui.builder.maxOrderPct')}
                value={config.maxOrderPct}
                min={0.1}
                max={20}
                step={0.1}
                onChange={(value: number) => setConfig({ ...config, maxOrderPct: value })}
              />
              <NumberField
                id="builder-loss-pct"
                label={t('ui.builder.dailyLossLimitPct')}
                value={config.dailyLossLimitPct}
                min={0.1}
                max={20}
                step={0.1}
                onChange={(value: number) => setConfig({ ...config, dailyLossLimitPct: value })}
              />
              <NumberField
                id="builder-order-count"
                label={t('ui.builder.maxOrdersPerDay')}
                value={config.maxOrdersPerDay}
                min={1}
                max={20}
                step={1}
                onChange={(value: number) => setConfig({ ...config, maxOrdersPerDay: value })}
              />
              {/* 提案通知开关 */}
              <div className="flex items-center justify-between rounded-lg border border-border p-4 md:col-span-2">
                <div>
                  <Label htmlFor="builder-notify">{t('ui.builder.notifyOnProposal')}</Label>
                  <p className="mt-1 text-xs text-muted-foreground">{t('ui.builder.notifyHint')}</p>
                </div>
                <Switch
                  id="builder-notify"
                  checked={config.notifyOnProposal}
                  onCheckedChange={(checked: boolean) =>
                    setConfig({ ...config, notifyOnProposal: checked })
                  }
                />
              </div>
              {/* 自定义提示词：最长 2000 字 + 设置入口链接 */}
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="builder-prompt">{t('ui.builder.customPrompt')}</Label>
                <Textarea
                  id="builder-prompt"
                  rows={4}
                  value={config.customPrompt}
                  maxLength={2000}
                  placeholder={t('ui.builder.promptPlaceholder')}
                  onChange={(event) => setConfig({ ...config, customPrompt: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {t('ui.builder.promptHint')}{' '}
                  <Link
                    to="/settings"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('ui.builder.openApiSettings')}
                  </Link>
                </p>
              </div>
            </div>
            {/* 上一步 / 预览行为（预览请求中禁用） */}
            <div className="flex justify-between gap-3">
              <Button type="button" variant="outline" onClick={() => setStep(0)}>
                <ChevronLeft /> {t('ui.builder.back')}
              </Button>
              <Button
                type="button"
                onClick={() => void goToPreview()}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending && <Loader2 className="animate-spin" />}
                {t('ui.builder.previewBehavior')} <ChevronRight />
              </Button>
            </div>
          </>
        )}

        {/* —— 步骤 2：行为预览（必须已有预览数据）—— */}
        {step === 2 && previewMutation.data && (
          <>
            <div>
              <h3 className="text-lg font-semibold">{t('ui.builder.previewTitle')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.previewHint')}</p>
            </div>
            {/* 场景卡：结果三色（paper 绿 / block 红 / ask 琥珀），key 与解释走译文缺省原文 */}
            <div className="grid gap-3 md:grid-cols-2">
              {previewMutation.data.scenarios.map((scenario) => (
                <div key={scenario.key} className="rounded-lg border border-border p-4">
                  <span
                    className={`text-xs font-semibold uppercase tracking-wide ${
                      scenario.result === 'paper'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : scenario.result === 'block'
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {t(`ui.builder.previewResult.${scenario.result}`)}
                  </span>
                  <p className="mt-2 font-medium">
                    {t(`ui.builder.scenario.${scenario.key}`, {
                      defaultValue: scenario.key,
                    })}
                  </p>
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
            {/* 仅模拟盘提示（琥珀横幅） */}
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              {t('ui.builder.paperOnlyNotice')}
            </p>
            {/* 投委会模式与节奏摘要（cadence 缺省回退默认值） */}
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-6">
              <p>
                {t(config.council?.enabled ? 'council.team.enabledHint' : 'council.team.rulesOnly')}
              </p>
              <p className="mt-2 text-muted-foreground">
                {t('council.cadence.summary', {
                  days:
                    config.cadence?.reviewEveryTradingDays ??
                    DEFAULT_CADENCE.reviewEveryTradingDays,
                  orders: config.cadence?.maxOrdersPerWeek ?? DEFAULT_CADENCE.maxOrdersPerWeek,
                })}
              </p>
            </div>
            {/* 什么时候走到这里：填了自定义提示词——模型相关提醒 + 设置链接 */}
            {config.customPrompt && (
              <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                {t('ui.builder.modelNotice')}{' '}
                <Link
                  to="/settings"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {t('ui.builder.openApiSettings')}
                </Link>
              </p>
            )}
            {/* 上一步 + 两个提交入口（保存草稿 / 保存并激活，文案按新建或编辑区分） */}
            <div className="flex flex-wrap justify-between gap-3">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                <ChevronLeft /> {t('ui.builder.back')}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ activate: false, config })}
                >
                  {t(editing ? 'ui.builder.saveDraft' : 'ui.builder.createDraft')}
                </Button>
                <Button
                  type="button"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ activate: true, config })}
                >
                  {saveMutation.isPending && <Loader2 className="animate-spin" />}
                  {t(editing ? 'ui.builder.saveAndActivate' : 'ui.builder.createAndActivate')}
                </Button>
              </div>
            </div>
          </>
        )}

        {/* —— 步骤 3：完成页（保存成功后）—— */}
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
              {/* 跳转投委会（携带 profileId） */}
              <Button asChild variant="outline">
                <Link to={`/council?profileId=${encodeURIComponent(saved.id)}`}>
                  {t('council.open')}
                </Link>
              </Button>
              {/* 什么时候走到这里：保存的是草稿（未激活）——提供激活按钮 */}
              {saved.status !== 'active' && (
                <Button
                  type="button"
                  onClick={() => activateMutation.mutate(saved.id)}
                  disabled={activateMutation.isPending}
                >
                  {t('ui.builder.activate')}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>
                {t('ui.builder.done')}
              </Button>
            </div>
          </div>
        )}

        {/* 什么时候走到这里：任一步骤的表单校验失败——错误提示（步骤切换时清空） */}
        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// 数字字段入参：id/标签/当前值/范围/步长/变更回调
interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

/** 通用数字输入字段：受控 number 输入，onChange 直接回传 Number(输入值)。 */
function NumberField({ id, label, value, min, max, step, onChange }: NumberFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
