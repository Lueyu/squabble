# 📊 研究数据 / Research data

## 中文

- **行情**使用现有行情服务；**估值、近期公司新闻、财报**先使用当前账户的 Finnhub 配置。Finnhub 财报缺项或请求失败时，自动查询免费的 SEC 原始申报。来源不可用是采集状态，不是公司经营恶化的证据。
- **SEC 备用财报**通过股票代码映射、申报记录和 Company Facts 交叉校验。收入、利润、经营现金流、负债必须匹配同一申报编号、报告截止日和币种；期间数据还需匹配起始日。现金流按实际期间展示，可能是年初至今累计值，不会伪装成单季度、年化值或增长率。缺项、冲突、未来日期和过旧报告不会被补成“完整”。[SEC API 文档](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- **覆盖范围**：当前 SEC 解析器支持美股上市公司的标准 US-GAAP 科目，不承诺覆盖全部发行人、基金或 IFRS 科目；港股、A 股代码没有此备用接口。历史 K 线尚未接入，因此均线、RSI、MACD 等缺口仍真实保留。网页摘录也不能补充成已核实的财务指标。
- **可选财务科目**：在同一申报和期间存在时，另附 PP&E 现金资本开支、现金及现金等价物、母公司股东权益、资产、毛利润和经营利润。自由现金流是应用按 `经营现金流 − PP&E 现金资本开支` 推导的非 GAAP 口径，不是供应商原始科目、TTM、年化值，也不表示偿付全部义务后可自由支配的现金；缺少或不匹配的可选科目不会扩大必需财报缺口。[SEC 非 GAAP 说明 102.07](https://www.sec.gov/rules-regulations/staff-guidance/corporation-finance-interpretations/non-gaap-financial-measures)
- **缓存与访问**：SEC 股票映射缓存 24 小时，财报结果缓存 1 小时，失败缓存 1 分钟；并发相同请求合并，每个未命中查询最多 3 个固定地址请求。单实例请求间隔至少 300 毫秒，每次超时 10 秒、响应上限 12 MiB。仅访问指定 SEC 主机，不跟随重定向。部署方可用 `SEC_USER_AGENT` 声明真实应用身份和联系人；默认只声明本应用名称，不编造联系信息。[SEC 访问政策](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
- **可选网页研究**默认关闭。明确开启后，可使用已保存的官方 DeepSeek 连接，调用官方 Search API；按固定股票代码检索，最多 3 个公开 HTTPS 来源，只保留有限摘录，不直接抓取任意 URL。网页内容作为研究线索，不属于已核实财报。[DeepSeek Search API](https://api-docs.deepseek.com/api/search/)
- **网页费用与限额**独立于模型 token 预算。供应商按成功请求计费，具体计费时间与价格以官方文档为准。本地最多预留 **每个讨论任务 2 次、每个账户每 UTC 日 20 次**请求；失败或取消仍占用本地请求额度，继续讨论不会重置任务额度，且不自动重试。进度记录显示实际采集、缓存命中和失败状态，不泄漏密钥。[DeepSeek 计费说明](https://api-docs.deepseek.com/guides/search/#billing)

## English

Quotes use the existing quote provider. Valuation, recent company news and statements use the caller’s Finnhub connection. Incomplete or failed statement retrieval falls back to public SEC filings. Source availability is distinct from company risk.

SEC facts are matched to one accession, period end and currency; duration facts also share a start date. Cumulative cash flow is labelled by its actual period. Conflicting, stale, future or missing values remain gaps. The current parser covers standard US-GAAP concepts for U.S. listings; it does not promise all issuer/IFRS coverage or HK/CN exchange support. Historical-price indicators remain unavailable until a history source is connected. See the [SEC API reference](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).

SEC requests use fixed hosts, bounded downloads, rate spacing, deduplication and public-data caches: ticker mapping 24 hours, results 1 hour, failures 1 minute. `SEC_USER_AGENT` accepts a real deployment identity; no contact is invented. See [SEC access guidance](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data).

Optional same-filing facts include PP&E cash capex, cash/equivalents, parent equity, assets, gross profit and operating income. Derived free cash flow is the application's non-GAAP calculation `CFO − PP&E cash capex` for the matched actual period, not a reported source metric, TTM, annualization or residual cash after every obligation. Optional omissions do not change required statement coverage. See [SEC interpretation 102.07](https://www.sec.gov/rules-regulations/staff-guidance/corporation-finance-interpretations/non-gaap-financial-measures).

Web research requires explicit opt-in and an official DeepSeek connection. Search results are bounded, linked context, never verified financial statements. Request-based provider charges are separate from model tokens. Atomic local reservations cap each discussion task at **2 requests** and each account at **20 requests per UTC day**, including failed/cancelled reservations. Resuming does not reset the task allowance; requests are not automatically retried. See [Search documentation and billing](https://api-docs.deepseek.com/guides/search/).
