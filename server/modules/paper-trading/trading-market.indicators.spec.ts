import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTradingTicker, type TradingMarketCandle } from '@shared/trading-market.interface';
import { calculateTradingIndicators } from './trading-market.indicators';

function candles(count = 60): TradingMarketCandle[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 7, 1 + index)).toISOString(),
    open: index + 10, close: index + 10, high: index + 12, low: index + 8, volume: 100,
  }));
}

test('daily SMA, Wilder RSI/ATR and volume ratio have known values on a rising series', () => {
  const input = candles();
  input[59].volume = 200;
  const result = calculateTradingIndicators(input);
  assert.ok(result);
  assert.equal(result.sma20, 59.5);
  assert.equal(result.sma50, 44.5);
  assert.equal(result.rsi14, 100);
  assert.equal(result.atr14, 4);
  assert.equal(result.volumeRatio, 2);
  assert.equal(result.asOf, input[59].timestamp);
  assert.equal(result.timeframe, '1d');
});

test('flat and falling series define RSI without NaN or division by zero', () => {
  const flat = candles().map(candle => ({ ...candle, open: 100, close: 100, high: 102, low: 98 }));
  assert.equal(calculateTradingIndicators(flat)?.rsi14, 50);
  const falling = candles().map((candle, index) => ({ ...candle,
    open: 100 - index, close: 100 - index, high: 102 - index, low: 98 - index }));
  assert.equal(calculateTradingIndicators(falling)?.rsi14, 0);
});

test('Wilder smoothing follows its geometric decay after a trend and volatility regime change', () => {
  const input = candles().map((candle, index) => {
    const close = index <= 14 ? 100 + index : 114 - (index - 14);
    const width = index <= 14 ? 2 : 3;
    return { ...candle, open: close, close, high: close + width, low: close - width };
  });
  const result = calculateTradingIndicators(input);
  assert.ok(result);
  const decay = (13 / 14) ** 45;
  assert.ok(Math.abs(result.rsi14 - 100 * decay) < 1e-10);
  assert.ok(Math.abs(result.atr14 - (6 - 2 * decay)) < 1e-10);
});

test('insufficient, unordered, duplicate and malformed OHLCV never yield indicators', () => {
  assert.equal(calculateTradingIndicators([]), null);
  assert.equal(calculateTradingIndicators(candles(49)), null);
  assert.equal(calculateTradingIndicators(candles().reverse()), null);
  for (const change of [{ close: NaN }, { high: 1 }, { volume: -1 }, { timestamp: 'invalid' }]) {
    const invalid = candles();
    invalid[20] = { ...invalid[20], ...change };
    assert.equal(calculateTradingIndicators(invalid), null);
  }
  const duplicate = candles();
  duplicate[20].timestamp = duplicate[19].timestamp;
  assert.equal(calculateTradingIndicators(duplicate), null);
  assert.equal(calculateTradingIndicators(candles().map(candle => ({ ...candle, volume: 0 }))), null);
});

test('ticker mappings allow only supported exchanges and safe provider symbols', () => {
  assert.deepEqual(resolveTradingTicker(' aapl '), { ticker: 'AAPL', providerSymbol: 'AAPL', market: 'US', currency: 'USD' });
  assert.equal(resolveTradingTicker('BRK.B')?.providerSymbol, 'BRK-B');
  assert.equal(resolveTradingTicker('00700')?.providerSymbol, '0700.HK');
  assert.equal(resolveTradingTicker('700.HK')?.providerSymbol, '0700.HK');
  assert.equal(resolveTradingTicker('600519.SH')?.providerSymbol, '600519.SS');
  assert.equal(resolveTradingTicker('000001')?.providerSymbol, '000001.SZ');
  assert.equal(resolveTradingTicker('300750.SZ')?.market, 'CN');
  for (const input of ['AAPL?range=1d', 'https://localhost', 'TSCO.L', '830799.BJ', 'AAPL.HK', '123456', '']) {
    assert.equal(resolveTradingTicker(input), null);
  }
});
