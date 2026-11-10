import { resolveTradingTicker } from '@shared/trading-market.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SeedCurrency, SeedPositionInput } from './account-starting-points';

export default function CustomSeedFields({ positions, onPositions, cash, onCash, zh, disabled }: {
  positions: SeedPositionInput[]; onPositions: (value: SeedPositionInput[]) => void;
  cash: Partial<Record<SeedCurrency, string>>; onCash: (value: Partial<Record<SeedCurrency, string>>) => void;
  zh: boolean; disabled: boolean;
}) {
  const update = (id: string, key: 'ticker' | 'shares' | 'cost', value: string) =>
    onPositions(positions.map(position => position.id === id ? { ...position, [key]: value } : position));
  return <fieldset disabled={disabled} className="space-y-4">
    <legend className="mb-3 text-sm font-medium">{zh ? '初始持仓' : 'Opening holdings'}</legend>
    {positions.map((position, index) => {
      const security = resolveTradingTicker(position.ticker);
      return <div className="companion-seed-row" key={position.id}>
        <label className="space-y-1 text-xs"><span>{zh ? '证券代码' : 'Ticker'} {index + 1}</span>
          <Input value={position.ticker} maxLength={20} placeholder="AAPL / 0700.HK / 600519.SH" onChange={event => update(position.id, 'ticker', event.target.value)} />
          <span className="text-muted-foreground">{security ? `${security.market} · ${security.currency}` : zh ? '支持美股、港股、A 股' : 'US, HK and CN securities'}</span>
        </label>
        <label className="space-y-1 text-xs"><span>{zh ? '数量' : 'Quantity'} {index + 1}</span>
          <Input type="number" min="0" max="1000000000000" step="any" value={position.shares} onChange={event => update(position.id, 'shares', event.target.value)} /></label>
        <label className="space-y-1 text-xs"><span>{zh ? '参考成本（选填）' : 'Reference cost (optional)'} {index + 1}</span>
          <Input type="number" min="0" max="1000000000000" step="any" value={position.cost} onChange={event => update(position.id, 'cost', event.target.value)} /></label>
        <Button variant="ghost" disabled={positions.length <= 1} aria-label={zh ? `移除持仓 ${index + 1}` : `Remove holding ${index + 1}`} onClick={() => onPositions(positions.filter(item => item.id !== position.id))}>{zh ? '移除' : 'Remove'}</Button>
      </div>;
    })}
    <Button variant="outline" disabled={positions.length >= 100} onClick={() => onPositions([...positions, { id: crypto.randomUUID(), ticker: '', shares: '', cost: '' }])}>{zh ? '添加持仓' : 'Add holding'}</Button>
    <div className="grid gap-3 sm:grid-cols-3">{(['USD', 'HKD', 'CNY'] as const).map(currency =>
      <label key={currency} className="space-y-1 text-xs"><span>{currency} {zh ? '初始现金' : 'opening cash'}</span>
        <Input type="number" min="0" max="1000000000000" step="any" placeholder="0" value={cash[currency] ?? ''} onChange={event => onCash({ ...cash, [currency]: event.target.value })} />
      </label>)}</div>
    <p className="text-xs leading-6 text-muted-foreground">{zh ? '现金留空即明确以零现金开始。参考成本仅保留记录；起点采用预览时的可用行情与汇率，之后向前观察，不是历史回测。' : 'Blank cash means zero opening cash. Reference costs are retained as notes; available market quotes and FX establish the starting value. Observation begins from here, with no historical backtest.'}</p>
  </fieldset>;
}
