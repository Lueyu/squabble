import type { TradingMarketCandle, TradingMarketIndicators } from '@shared/trading-market.interface';

export function validTradingCandle(candle: TradingMarketCandle): boolean {
  return Number.isFinite(Date.parse(candle.timestamp))
    && [candle.open, candle.high, candle.low, candle.close].every(value => Number.isFinite(value) && value > 0)
    && Number.isFinite(candle.volume) && candle.volume >= 0
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= Math.max(candle.open, candle.close) && candle.low <= candle.high;
}

/** Uses only valid, strictly ordered completed daily bars. Does not fill missing data. */
export function calculateTradingIndicators(candles: TradingMarketCandle[]): TradingMarketIndicators | null {
  if (candles.length < 50 || candles.some((candle, index) => !validTradingCandle(candle)
    || (index > 0 && Date.parse(candle.timestamp) <= Date.parse(candles[index - 1].timestamp)))) return null;
  let gain = 0;
  let loss = 0;
  let atr = 0;
  for (let index = 1; index < candles.length; index++) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const change = candle.close - previous.close;
    const tr = Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close));
    if (index <= 14) {
      gain += Math.max(0, change);
      loss += Math.max(0, -change);
      atr += tr;
      if (index === 14) { gain /= 14; loss /= 14; atr /= 14; }
    } else {
      gain = (gain * 13 + Math.max(0, change)) / 14;
      loss = (loss * 13 + Math.max(0, -change)) / 14;
      atr = (atr * 13 + tr) / 14;
    }
  }
  const meanVolume = candles.slice(-21, -1).reduce((sum, candle) => sum + candle.volume, 0) / 20;
  if (meanVolume <= 0) return null;
  const sma = (period: number): number => candles.slice(-period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const result: TradingMarketIndicators = {
    sma20: sma(20), sma50: sma(50),
    rsi14: loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss),
    atr14: atr, volumeRatio: candles[candles.length - 1].volume / meanVolume,
    asOf: candles[candles.length - 1].timestamp, sampleSize: candles.length, timeframe: '1d',
  };
  return [result.sma20, result.sma50, result.rsi14, result.atr14, result.volumeRatio].every(Number.isFinite)
    ? result : null;
}
