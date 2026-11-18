import type { AiInvestmentPreview } from '@shared/investment-policy.interface';

/** Read-only evidence shown before a new team's independent paper ledger is created. */
export function TeamAccountSeedReview({ preview, zh, compact = false }: { preview: AiInvestmentPreview; zh: boolean; compact?: boolean }) {
  const count = preview.seed.positions.length;
  const snapshot = new Date(preview.seed.capturedAt).toLocaleString(zh ? 'zh-CN' : 'en', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
  });
  if (compact) return <section className="space-y-4 rounded-xl border bg-card p-5" aria-label={zh ? '核对模拟起点' : 'Review the starting point'}>
    <h2 className="text-lg font-semibold">{zh ? '模拟起点' : 'Simulation starting point'}</h2>
    <dl className="grid gap-3 sm:grid-cols-2">
      <div><dt className="text-sm text-muted-foreground">{zh ? '持仓来源' : 'Position source'}</dt><dd className="font-medium">
        {zh ? `我的实仓 · ${count} 项持仓` : `Real portfolio · ${count} positions`}
      </dd></div>
      <div><dt className="text-sm text-muted-foreground">{zh ? '快照时间（北京时间）' : 'Snapshot time (Beijing)'}</dt>
        <dd className="font-medium"><time dateTime={preview.seed.capturedAt}>{snapshot}</time></dd>
      </div>
    </dl>
    {count > 0 && <details className="border-t pt-3">
      <summary className="cursor-pointer text-sm text-muted-foreground">{zh ? '查看快照内的持仓' : 'View positions in the snapshot'}</summary>
      <ul className="mt-2 divide-y text-sm">{preview.seed.positions.map(position => <li key={position.sourceHoldingId ?? `${position.market}:${position.ticker}`} className="flex justify-between gap-3 py-2">
        <span className="break-all">{position.ticker}</span><span>{position.shares} {zh ? '股' : 'shares'}</span>
      </li>)}</ul>
    </details>}
    <div className="border-t pt-4">
      <p className="text-sm text-muted-foreground">{zh ? '可用虚拟现金' : 'Available virtual cash'}</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        {preview.seed.cash.map(cash => <div key={cash.currency}>
          <dt className="text-sm text-muted-foreground">{cash.currency}</dt>
          <dd className="mt-1 rounded-md border px-3 py-2.5 font-medium tabular-nums">
            {Number(cash.total).toLocaleString(zh ? 'zh-CN' : 'en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </dd>
        </div>)}
      </dl>
    </div>
  </section>;
  return <section className="space-y-3 rounded-lg border p-4" aria-label={zh ? '核对新模拟盘起点' : 'Review the new paper account seed'}>
    <h3 className="font-semibold">{zh ? '本团队的新独立模拟盘' : 'A new independent paper account for this team'}</h3>
    <p className="text-sm">{zh ? '复制以下实仓持仓快照；实盘现金不作为本金。以下三币金额全部是可用虚拟现金。' : 'Copy the real-position snapshot below; real cash is not used as starting capital. The three currency amounts below are available virtual cash.'}</p>
    <p className="text-sm text-muted-foreground">{zh ? '快照时间' : 'Snapshot'}: {new Date(preview.seed.capturedAt).toLocaleString(zh ? 'zh-CN' : 'en')} · {preview.seed.positions.length} {zh ? '项持仓' : 'positions'}</p>
    {preview.seed.positions.length ? <div className="max-h-60 overflow-auto rounded border"><table className="w-full text-sm text-left"><thead><tr><th className="p-2">{zh ? '标的' : 'Security'}</th><th className="p-2">{zh ? '数量' : 'Quantity'}</th><th className="p-2">{zh ? '市场 / 币种' : 'Market / currency'}</th></tr></thead><tbody>{preview.seed.positions.map(position => <tr key={position.sourceHoldingId ?? `${position.market}:${position.ticker}`}><td className="p-2">{position.ticker}</td><td className="p-2">{position.shares}</td><td className="p-2">{position.market} / {position.currency}</td></tr>)}</tbody></table></div> : <p className="text-sm">{zh ? '实仓没有持仓，新模拟盘将从以下虚拟现金开始。' : 'There are no real positions; the new paper account starts with the virtual cash below.'}</p>}
    <ul className="flex flex-wrap gap-3 text-sm">{preview.seed.cash.map(cash => <li className="rounded bg-muted p-2" key={cash.currency}>{cash.currency} {cash.total}</li>)}</ul>
    <p className="text-xs text-muted-foreground">{zh ? '每次创建均产生新账户。后续实仓变动不会覆盖模拟盘；配员和运行预算核对完成前不会启动研究或模拟交易。' : 'Every creation makes a new account. Later real-portfolio changes do not overwrite it; research and paper trades start only after staffing and run-budget review.'}</p>
  </section>;
}
