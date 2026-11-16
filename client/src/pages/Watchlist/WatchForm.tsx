/**
 * WatchForm.tsx — 自选股受控表单（新增与编辑对话框共用）。
 *
 * 职责边界：
 *  - 只渲染表单网格并回抛字段变更：所有字段都是 string（数字输入框的值也保持字符串，
 *    数字解析由父组件在提交时负责）；
 *  - includeTicker 为 false（编辑已有自选项）时隐藏代码输入框——代码创建后不可改。
 * 上下游：
 *  - 上游：WatchlistPage 的 DetailDialog（编辑态）与新增对话框（创建态），data / onChange 均由父组件托管；
 *  - 下游：@/components/ui 的 Input / Select 系 / Textarea、react-i18next（文案）。
 * 关键约定：
 *  - SIGNAL_OPTIONS 的取值是存储在库里的中文原文；展示时经 localizedSignal 映射到 i18n key，
 *    未命中映射的信号值原样展示（新增信号需同步维护该映射）；
 *  - RATING_OPTIONS 为英文评级原文，直接作为 Select 的 value 与展示值。
 */
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from 'react-i18next';

/** 自选股表单的受控数据模型（全部为 string，数字字段由父组件提交时解析）。 */
export interface WatchFormData {
  ticker: string;
  company: string;
  sector: string;
  dateAdded: string;
  entryPrice: string;
  currentPrice: string;
  targetBuy: string;
  rating: string;
  signal: string;
  analysis: string;
}

/** 信号下拉的可选值（与库中存储的中文原文一致）。 */
const SIGNAL_OPTIONS = ['强烈买入', '买入', '观望', '回避'];
/** 评级下拉的可选值（英文原文）。 */
const RATING_OPTIONS = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'];

/** {@link WatchForm} 的入参。 */
interface WatchFormProps {
  /** 当前表单值（受控，状态由父组件持有）。 */
  data: WatchFormData;
  /** 字段变更回调，收到合并后的完整下一份表单状态。 */
  onChange: (d: WatchFormData) => void;
  /** 为 true 时显示代码输入框（新增对话框用）；编辑态传 false 隐藏。 */
  includeTicker?: boolean;
}

/**
 * 渲染自选股表单网格（代码 / 公司 / 行业 / 加入日期 / 三个价格 / 评级 / 信号 / 分析）。
 * @param props - 见 {@link WatchFormProps}。
 */
function WatchForm({ data, onChange, includeTicker }: WatchFormProps) {
  const { t } = useTranslation();
  // 信号值 → i18n key 的本地化映射；映射表未收录的值原样返回。
  const localizedSignal = (signal: string) => {
    const keys: Record<string, string> = {
      强烈买入: 'analysis.strongBuy',
      买入: 'analysis.buy',
      观望: 'analysis.watch',
      回避: 'analysis.avoid',
    };
    return keys[signal] ? t(keys[signal]) : signal;
  };
  // 单字段更新：合并进完整表单对象后回抛给父组件。
  const update = (k: keyof WatchFormData, v: string) => onChange({ ...data, [k]: v });

  // 渲染区：两列表单网格（分析备注占满两列）。
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {/* 代码：仅新增态渲染；输入即转大写。 */}
      {includeTicker && (
        <div className="space-y-1.5 sm:col-span-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t('watchlist.ticker')} <span className="text-destructive">*</span>
          </label>
          <Input
            value={data.ticker}
            onChange={(e) => update('ticker', e.target.value.toUpperCase())}
            placeholder={t('ui.holdings.tickerExample')}
            className="font-mono-nums"
          />
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t('watchlist.company')}
        </label>
        <Input
          value={data.company}
          onChange={(e) => update('company', e.target.value)}
          placeholder={t('watchlist.company')}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t('ui.holdings.sector')}
        </label>
        <Input
          value={data.sector}
          onChange={(e) => update('sector', e.target.value)}
          placeholder={t('ui.holdings.sector')}
        />
      </div>
      {/* 加入日期：原生 date input，值为 YYYY-MM-DD 字符串。 */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t('ui.watchlist.joinedDate')}
        </label>
        <Input
          type="date"
          value={data.dateAdded}
          onChange={(e) => update('dateAdded', e.target.value)}
        />
      </div>
      {/* 三个价格字段：number 输入框，但值仍以字符串保存在 data 中，提交时由父组件解析。 */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t('ui.watchlist.entryPrice')}
        </label>
        <Input
          type="number"
          step="0.01"
          value={data.entryPrice}
          onChange={(e) => update('entryPrice', e.target.value)}
          className="font-mono-nums"
          placeholder="0.00"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t('watchlist.currentPrice')}
        </label>
        <Input
          type="number"
          step="0.01"
          value={data.currentPrice}
          onChange={(e) => update('currentPrice', e.target.value)}
          className="font-mono-nums"
          placeholder="0.00"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t('watchlist.targetBuyPrice')}
        </label>
        <Input
          type="number"
          step="0.01"
          value={data.targetBuy}
          onChange={(e) => update('targetBuy', e.target.value)}
          className="font-mono-nums"
          placeholder="0.00"
        />
      </div>
      {/* 评级下拉：value 与展示值都是英文原文。 */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('watchlist.rating')}</label>
        <Select value={data.rating} onValueChange={(v) => update('rating', v)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('ui.holdings.chooseRating')} />
          </SelectTrigger>
          <SelectContent>
            {RATING_OPTIONS.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* 信号下拉：存储中文原文，展示走 localizedSignal 本地化。 */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('watchlist.signal')}</label>
        <Select value={data.signal} onValueChange={(v) => update('signal', v)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('ui.watchlist.signalFilter')} />
          </SelectTrigger>
          <SelectContent>
            {SIGNAL_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {localizedSignal(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* 分析备注：占满两列。 */}
      <div className="space-y-1.5 sm:col-span-2">
        <label className="text-xs font-medium text-muted-foreground">
          {t('ui.holdings.analysis')}
        </label>
        <Textarea
          value={data.analysis}
          onChange={(e) => update('analysis', e.target.value)}
          placeholder={t('ui.holdings.analysis')}
          rows={4}
          className="resize-y"
        />
      </div>
    </div>
  );
}

export default WatchForm;
