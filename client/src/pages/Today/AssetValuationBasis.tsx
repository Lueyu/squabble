import { useTranslation } from 'react-i18next';
import type { AssetValuationProvenance } from '@shared/simple-experience.interface';
import { businessTime } from '@/utils/strategy-dates';

export default function AssetValuationBasis({provenance,timezone}:{provenance:AssetValuationProvenance;timezone:string}) {
  const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
  const time=(value:string|null)=>value?businessTime(value,timezone):(zh?'未提供':'Not reported');
  return <details className="min-w-0 rounded-xl border px-4 py-3 text-xs" aria-label={zh?'行情和汇率依据':'Quote and FX basis'}>
    <summary className="cursor-pointer font-medium">{zh?'行情和汇率依据':'Quote and FX basis'}</summary>
    <div className="mt-3 space-y-4 leading-6 text-muted-foreground [overflow-wrap:anywhere]">
      <p>{zh?'行情时点与资料读取时间分别保留；以下时间按账户时区显示。':'Market observations and retrieval times are separate. Times below use your account timezone.'} · {timezone}</p>
      {!!provenance.quotes.length&&<div className="grid gap-3 sm:grid-cols-2">{provenance.quotes.map(quote=><article key={`${quote.market}:${quote.ticker}`} className="space-y-1 rounded-lg bg-muted/30 p-3">
        <h3 className="font-medium text-foreground">{quote.ticker} · {quote.market}</h3>
        <p>{zh?'行情来源：':'Quote source: '}{quote.source==='imported'?(zh?'导入参考，非实时行情':'Imported reference, not a live quote'):quote.source|| (zh?'未提供':'Not reported')}</p>
        <p>{zh?'实际行情时间：':'Market observation: '}{time(quote.quoteAt)}</p>
        <p>{zh?'资料读取时间：':'Retrieved: '}{time(quote.retrievedAt)}</p>
        <p>{zh?'行情交易日：':'Quote trading date: '}{quote.tradingDate??(zh?'未提供':'Not reported')}</p>
        <p>{zh?'昨收对应交易日：':'Previous close date: '}{quote.previousCloseDate??(zh?'未提供':'Not reported')}</p>
      </article>)}</div>}
      {!!provenance.fx.length&&<div className="space-y-2"><h3 className="font-medium text-foreground">{zh?'折算为美元的汇率':'Conversion to USD'}</h3>{provenance.fx.map(fx=><div key={fx.currency} className="rounded-lg bg-muted/30 p-3">
        <p className="font-medium text-foreground">{fx.currency}{fx.source==='identity'?(zh?' · 同币种，无需换汇':' · Same currency, no conversion'):fx.usdRate==null?(zh?' · 汇率缺失':' · Rate unavailable'):` · 1 ${fx.currency} = ${new Intl.NumberFormat(i18n.language,{maximumFractionDigits:8}).format(fx.usdRate)} USD`}</p>
        {fx.source!=='identity'&&<p>{fx.source==='recorded'?(zh?'已记录汇率':'Recorded rate'):(zh?'汇率缺失，尚未计入完整资产':'Missing rate, excluded from complete equity')}{fx.rateDate?` · ${fx.rateDate}`:''}{fx.direction==='inverse'?(zh?' · 反向换算':' · Inverse conversion'):''}</p>}
      </div>)}</div>}
    </div>
  </details>;
}
