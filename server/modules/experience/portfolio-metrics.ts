import type { Market } from '../../../shared/api.interface';
import { lastCompletedTradingDate, tradingMarketSchedule, tradingMarketDate } from '../paper-trading/trading-market.calendar';
export interface PortfolioFxRow { base: string; quote: string; rate: string | number; rateDate: string }
export interface MetricsHolding { ticker: string; shares: string | number; currentPrice: string | number | null; currency: string | null; market: string | null }
export interface MetricsCash { currency: string; balance: string | number; reconciliationStatus?: string }
export interface MetricsTransaction { ticker: string; txType: string; txDate: string; shares: string | number; price: string | number; fees: string | number | null; currency: string | null }
export interface MetricsQuote { symbol: string; price: string; previousClose?: string; currency: string; market: string; quoteAt?: string; tradingDate?: string; source?: string }
export interface PortfolioMetricsInput { at: Date; timezone: string; holdings: MetricsHolding[]; cash: MetricsCash[]; rates: PortfolioFxRow[]; quotes: Record<string, MetricsQuote | null | undefined>; transactions: MetricsTransaction[] }
export interface PortfolioMetrics { totalValueUsd: number | null; knownValueUsd: number; holdingsValueUsd: number; cashUsd: number | null; knownCashUsd: number;
  dailyPnlUsd: number | null; knownDailyPnlUsd: number | null; returnPct: number | null; partial: boolean; estimated: boolean; gaps: string[];
  marketTimes: Array<{market: string; dataAsOf: string | null; tradingDate: string | null}> }
const number = (value: unknown): number | null => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const rounded = (value: number) => Math.round((value + Number.EPSILON) * 1e8) / 1e8;
const market = (value: string | null, currency?: string | null): Market => value === 'HK' || value === 'CN' ? value : currency === 'HKD' ? 'HK' : currency === 'CNY' ? 'CN' : 'US';
export function resolvePortfolioFx(rows: PortfolioFxRow[], currency: string, day: string): {rate: number; date: string} | null {
  if (currency === 'USD') return {rate: 1, date: day};
  const pairs = rows.filter(r => r.rateDate <= day && Date.parse(day) - Date.parse(r.rateDate) <= 10 * 86_400_000
    && Number(r.rate) > 0 && Number.isFinite(Number(r.rate))
    && (r.base === currency && r.quote === 'USD' || r.base === 'USD' && r.quote === currency))
    .sort((a,b) => b.rateDate.localeCompare(a.rateDate)||Number(b.base===currency)-Number(a.base===currency));
  const pair = pairs[0];
  return pair ? {rate: pair.base === currency ? Number(pair.rate) : 1 / Number(pair.rate), date: pair.rateDate} : null;
}
/** Latest market day represented by regular-session prices; weekends do not invent sessions. */
export function portfolioMarketDay(m: Market, at: Date): string | null {
  const schedule = tradingMarketSchedule(m,at);
  return schedule.isTradingDay && schedule.opensAt && Date.parse(schedule.opensAt) <= at.getTime()
    ? schedule.tradingDate : lastCompletedTradingDate(m,at);
}
export function computePortfolioMetrics(input: PortfolioMetricsInput): PortfolioMetrics {
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:input.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(input.at);
  const gaps = new Set<string>();
  let knownValueUsd = 0, holdingsValueUsd = 0, knownCashUsd = 0, partial = false, estimated = input.holdings.length>0;
  let dailyComplete = true, dailyPnl = 0, dailyParts = 0, openingValue = 0;
  const marketTimes = new Map<string,PortfolioMetrics['marketTimes'][number]>();
  const cashGroups = new Map<string,MetricsCash[]>();
  for(const row of input.cash)cashGroups.set(row.currency,[...(cashGroups.get(row.currency)??[]),row]);
  for(const currency of [...input.holdings.map(row=>row.currency),...input.transactions.filter(row=>row.txType!=='Opening').map(row=>row.currency)])if(currency&&!cashGroups.has(currency))cashGroups.set(currency,[]);
  // Recorded expenses remain known even when an opening cash balance is not yet reconciled.
  for(const tx of input.transactions.filter(t=>['Deposit','Withdrawal','Fee'].includes(t.txType))) {
    const cashDay=portfolioMarketDay(market(null,tx.currency),input.at);
    if(tx.txDate!==cashDay&&tx.txDate!==day)continue;
    const quantity=number(tx.shares),price=number(tx.price),fees=number(tx.fees),rate=resolvePortfolioFx(input.rates,tx.currency??'USD',day);
    if(quantity===null||price===null||fees===null||quantity<0||price<0||fees<0){dailyComplete=false;gaps.add('TRANSACTION_INCOMPLETE');continue;}
    const cost=tx.txType==='Fee'?quantity*price+fees:fees;
    if(cost===0)continue;
    if(!rate){dailyComplete=false;gaps.add(`FX_MISSING:${tx.currency}`);continue;}
    dailyPnl-=cost*rate.rate;dailyParts++;
  }
  let cashComplete = cashGroups.size > 0;
  for(const [currency,rows] of cashGroups) {
    const balance = rows.length === 1 ? number(rows[0].balance) : null;
    const rate = resolvePortfolioFx(input.rates,currency,day);
    if(balance === null || balance < 0 || rows[0]?.reconciliationStatus !== 'confirmed' || (!rate&&balance!==0)) {
      partial = true; cashComplete = false; gaps.add(rows.length > 1 ? 'CASH_DUPLICATE_REVIEW' : rows[0]?.reconciliationStatus!=='confirmed'||balance===null||balance<0 ? `CASH_UNCONFIRMED:${currency}` : `FX_MISSING:${currency}`);continue;
    }
    knownCashUsd += balance * (rate?.rate??0);
    const cashDay = portfolioMarketDay(market(null,currency),input.at);
    let cashDelta = 0;
    for(const tx of input.transactions.filter(t=>t.currency===currency&&(['Buy','Sell'].includes(t.txType)?t.txDate===cashDay:t.txDate===cashDay||t.txDate===day))) {
      if(!['Buy','Sell','Deposit','Withdrawal','Fee'].includes(tx.txType))continue;
      const shares=number(tx.shares),price=number(tx.price),fees=number(tx.fees);
      if(shares===null||price===null||fees===null||shares<0||price<0||fees<0){dailyComplete=false;gaps.add('TRANSACTION_INCOMPLETE');continue;}
      const amount=shares*price;
      cashDelta += tx.txType==='Buy' ? -amount-fees : tx.txType==='Sell' ? amount-fees
        : tx.txType==='Deposit' ? amount-fees : -amount-fees;
    }
    const openingCash=balance-cashDelta;
    if(openingCash < -1e-7){dailyComplete=false;gaps.add('CASH_OPENING_REQUIRES_RECONCILIATION');}
    else if(openingCash>1e-7&&!rate){dailyComplete=false;gaps.add(`FX_MISSING:${currency}`);}
    else openingValue+=Math.max(0,openingCash)*(rate?.rate??0);
  }
  if(!cashComplete) {partial=true;dailyComplete=false;gaps.add('CASH_UNCONFIRMED');}
  knownValueUsd += knownCashUsd;
  const positions = new Map(input.holdings.map(h=>[h.ticker,h]));
  for(const tx of input.transactions.filter(t=>t.txType==='Buy'||t.txType==='Sell')) {
    const m=market(null,tx.currency);
    if(tx.txDate===portfolioMarketDay(m,input.at)&&!positions.has(tx.ticker))positions.set(tx.ticker,{ticker:tx.ticker,shares:0,currentPrice:null,currency:tx.currency,market:m});
  }
  for(const row of positions.values()) {
    const m=market(row.market,row.currency),currency=row.currency??(m==='HK'?'HKD':m==='CN'?'CNY':'USD');
    const fx=resolvePortfolioFx(input.rates,currency,day),shares=number(row.shares),q=input.quotes[row.ticker];
    const quoteTime=q?.quoteAt?Date.parse(q.quoteAt):NaN;
    const offered=number(q?.price);
    const price=number(q&&q.market===m&&q.currency===currency&&offered!==null&&offered>0&&(!Number.isFinite(quoteTime)||quoteTime<=input.at.getTime()+120_000)?q.price:row.currentPrice);
    const schedule=tradingMarketSchedule(m,input.at);
    const observingSession=schedule.isTradingDay&&schedule.opensAt&&Date.parse(schedule.opensAt)<=input.at.getTime()&&schedule.closesAt&&input.at.getTime()<Date.parse(schedule.closesAt);
    const freshInSession=!observingSession||input.at.getTime()-quoteTime<=45*60_000;
    const quotedSchedule=Number.isFinite(quoteTime)?tradingMarketSchedule(m,new Date(quoteTime)):null;
    const quotedClose=quotedSchedule?.closesAt?Date.parse(quotedSchedule.closesAt):null;
    const closingObservation=quotedClose!==null&&input.at.getTime()>=quotedClose?quoteTime>=quotedClose-15*60_000:true;
    const dated=!!q&&Number.isFinite(quoteTime)&&freshInSession&&closingObservation&&quoteTime<=input.at.getTime()+120_000&&q.market===m&&q.currency===currency
      &&q.tradingDate===portfolioMarketDay(m,input.at)&&tradingMarketDate(m,new Date(quoteTime))===q.tradingDate;
    const prior=marketTimes.get(m);
    const actualTime=dated?q!.quoteAt!:null;
    if(!prior)marketTimes.set(m,{market:m,dataAsOf:actualTime,tradingDate:dated?q!.tradingDate!:null});
    else if(!actualTime||!prior.dataAsOf)marketTimes.set(m,{market:m,dataAsOf:null,tradingDate:null});
    else if(actualTime<prior.dataAsOf)marketTimes.set(m,{market:m,dataAsOf:actualTime,tradingDate:q!.tradingDate!});
    if(shares===null||shares<0){partial=true;dailyComplete=false;gaps.add(`HOLDING_INVALID:${row.ticker}`);continue;}
    if(shares>0) {
      if(price===null||price<=0||!fx){partial=true;gaps.add(!fx?`FX_MISSING:${currency}`:`PRICE_MISSING:${row.ticker}`);}
      else{const value=shares*price*fx.rate;knownValueUsd+=value;holdingsValueUsd+=value;}
    }
    if(!dated){estimated=true;gaps.add(`QUOTE_TIME_UNVERIFIED:${row.ticker}`);}
    const prev=number(q?.previousClose);
    if(!dated||prev===null||prev<=0||price===null||price<=0||!fx){dailyComplete=false;gaps.add(`DAILY_BASIS_MISSING:${row.ticker}`);continue;}
    const trades=input.transactions.filter(t=>t.ticker===row.ticker&&t.txDate===q!.tradingDate&&['Buy','Sell'].includes(t.txType));
    let openingShares=shares,pnl=shares*(price-prev),valid=true;
    for(const trade of trades) {
      const quantity=number(trade.shares),tradePrice=number(trade.price),fees=number(trade.fees);
      if(quantity===null||quantity<0||tradePrice===null||tradePrice<=0||fees===null||fees<0||trade.currency!==currency){valid=false;break;}
      const sign=trade.txType==='Buy'?-1:1;
      openingShares+=sign*quantity;pnl+=sign*quantity*(tradePrice-prev)-fees;
    }
    if(!valid||openingShares < -1e-7){dailyComplete=false;gaps.add(`TRANSACTION_RECONCILIATION:${row.ticker}`);continue;}
    openingValue+=Math.max(0,openingShares)*prev*fx.rate;dailyPnl+=pnl*fx.rate;dailyParts++;
  }
  if(!positions.size&&cashComplete&&input.cash.every(c=>c.currency==='USD'))dailyParts++;
  const completeDaily=dailyComplete&&dailyParts>0;
  return {totalValueUsd:partial?null:rounded(knownValueUsd),knownValueUsd:rounded(knownValueUsd),holdingsValueUsd:rounded(holdingsValueUsd),cashUsd:cashComplete?rounded(knownCashUsd):null,knownCashUsd:rounded(knownCashUsd),
    dailyPnlUsd:completeDaily?rounded(dailyPnl):null,knownDailyPnlUsd:dailyParts?rounded(dailyPnl):null,
    returnPct:completeDaily&&cashComplete&&openingValue>0?rounded(dailyPnl/openingValue*100):null,
    partial,estimated,gaps:[...gaps],marketTimes:[...marketTimes.values()]};
}
