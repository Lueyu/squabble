# 📸 Portfolio Import Guide

Three flows share one rule: **no holdings are written to the instance database
until you confirm the preview**. Every import is recorded in history with per-row reasons for
anything skipped.

## 📄 Generic CSV

1. Open **持仓导入** in the sidebar, choose **CSV 文件**.
2. Pick your file. Use a CSV with one holding per row —
   common column names (`symbol/ticker/股票代码`, `quantity/股数`,
   `cost/均价` …) are auto-detected; fix the mapping in the dropdowns if a
   column is misidentified.
3. If Chinese text renders as garbage, switch the encoding selector to
   **GBK** (common for domestic broker exports) and re-select the file.
4. Confirm the preview and import. Existing tickers are **skipped, never
   merged** — edit those positions on the holdings page instead.

## 📊 Robinhood CSV

Same flow with the **Robinhood 导出** preset selected — known headers
(`Symbol`, `Quantity`, `Cost Basis` …) are mapped automatically.

The current confirmed import paths are **Generic CSV**, **Robinhood CSV** and
**Screenshot OCR**. Other broker presets visible in the UI are not yet accepted
by the import API. Use Generic CSV and map the columns for those exports.

## 📷 Screenshot OCR

For a broker that cannot export a suitable CSV:

1. Take a screenshot of your broker app's holdings page
   (同花顺 / 东方财富 / 雪球 / 富途 / 老虎 / Robinhood …).
2. Choose **截图识别**, configure a vision-capable model with a compatible
   Chat Completions endpoint, using the model ID from your provider's console.
   This optional flow requires a model API key; CSV import does not.
3. Hit **开始识别**, review the editable extraction, then import.

**Privacy** (see [privacy.md](privacy.md)): OCR configuration and its key are
saved in this browser's local storage. When you request extraction, the key
and full screenshot pass through the instance's server to your chosen model
provider. The OCR handler does not persist the input image or key in the
database; confirmed extracted holdings and import history are stored there.
An operator's infrastructure or the provider can have separate logging and
retention policies. Crop account identifiers and unrelated personal details
before upload. OCR storage is separate from the encrypted LLM/Finnhub settings.
