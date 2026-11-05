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

1. Take up to 20 screenshots of your broker app's holdings pages
   (同花顺 / 东方财富 / 雪球 / 富途 / 老虎 / Robinhood …).
2. Choose **截图识别** and select the screenshots (PNG/JPEG/WebP, at most 8 MiB
   each and 160 MiB total). You can remove individual screenshots before or
   after recognition; removing a recognized image also removes its rows. A
   connected image-capable local agent is preferred;
   you can instead configure a vision-capable model with a compatible Chat
   Completions endpoint and a model API key. CSV import does not require one.
3. Hit **开始识别**. Each screenshot starts one task in sequence and may consume
   provider usage. If a task fails or its submission is uncertain, later
   screenshots pause. Check the original task by ID when needed, then explicitly
   resume or skip the remaining files. Successful rows remain available.
4. Review the combined editable rows and their source filenames. Remove or
   correct duplicate tickers and keep at most 200 rows, then confirm one import.

**Privacy** (see [privacy.md](privacy.md)): The vision API URL and model may be
saved in local storage; the API key stays in this page's memory. Each selected
image starts a separate recognition task. The selected local agent may send the
image to its model provider, or the image and key pass through the app backend
to the configured vision API. Screenshots and keys are handled temporarily;
confirmed holdings and import history are stored. Native agent task records may
retain extracted text under their existing history policy. Crop account
identifiers and unrelated personal details before upload, and check your
provider's separate logging and retention policies.
