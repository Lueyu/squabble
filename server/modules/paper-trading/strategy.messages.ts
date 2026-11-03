const ZH: Record<string, string> = {
  'Agent paused': 'Agent 已暂停',
  'Strategy check failed; no new order was executed': '策略检查失败，未执行新订单',
  'Waiting for scheduled pre-open discussion': '等待预定盘前讨论',
  'Trading calendar unavailable': '交易日历暂不可用',
  'Select at most 20 tickers per market for bounded daily discussion': '每日讨论每个市场最多选择 20 个标的',
  'Daily deep research discussion started': '每日深度研究讨论已开始',
  'Interrupted or uncertain paid work; pause and save a new profile version to explicitly retry': '模型任务中断或结果不明；请暂停并保存新版本后明确重试，系统不会自动重复付费调用',
  'No valid strategy remains': '当前没有仍有效的策略',
  'Discussion pending or interrupted; paid work is never replayed automatically': '讨论等待完成或已中断；系统不会自动重复付费调用',
  'Validated daily strategy ready': '已校验的每日策略已就绪',
  'Market data unavailable': '行情数据暂不可用',
  'No available cash, position allowance or sellable quantity': '可用现金、仓位额度或可卖数量不足',
  'Price left strategy bounds; bounded event replan started': '价格离开策略范围，已按次数限制启动事件重规划',
  'Daily discussion could not start; no automatic replay': '每日讨论未能启动，不会自动重复执行',
  'Daily discussion failed or was paused; previous valid plan retained': '每日讨论失败或已暂停，仍有效的旧策略保留',
  'Interrupted discussion dispatch; no automatic replay': '讨论任务派发中断，不会自动重复执行',
  'Strategy generation failed validation; previous valid plan retained': '策略生成未通过校验，仍有效的旧策略保留',
  'Execution stopped: profile, price, data or risk validation failed': '执行已停止：配置、价格、数据或风控检查未通过',
  'Invalid fast review response': '快速审核返回无效结果',
  'Hard risk blocked order': '硬风控已拦截订单',
  source_invalid: '行情来源数据无效', source_unavailable: '行情来源暂不可用', source_busy: '行情请求繁忙',
  quote_future: '报价时间异常', quote_stale: '报价已过期', stale_quote: '报价已过期',
  calendar_unavailable: '交易日历尚未验证', outside_session: '当前不在连续交易时段',
  market_closed: '市场已休市', market_holiday: '市场休市日', unsupported_ticker: '暂不支持此标的',
  history_invalid: '历史行情数据无效', history_insufficient: '历史行情不足，无法计算指标', history_stale: '历史行情尚未更新',
};
export function strategyReason(reason: string, language?: string): string {
  if (reason.startsWith('dispatching:')) return language === 'en' ? 'Daily research discussion in progress' : '每日研究讨论进行中';
  if (language === 'en') return reason;
  if (reason.startsWith('PAPER filled:')) return reason.replace('PAPER filled:', '模拟盘已成交：');
  return ZH[reason] ?? reason;
}
