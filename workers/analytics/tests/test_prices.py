import pytest
from squabble_analytics.prices import prices_to_returns


def test_tushare_and_aktools_raw_prices_are_sorted_and_converted_not_treated_as_returns():
    rows = [{"trade_date": "20200106", "close": "121", "_provenance": {"currency": None, "unit": None}},
            {"trade_date": "20200102", "close": "100", "_provenance": {"currency": None, "unit": None}},
            {"trade_date": "20200103", "close": "110", "_provenance": {"currency": None, "unit": None}}]
    parameters = {"dateColumn": "trade_date", "priceColumn": "close", "returnBasis": "unadjusted-price-only", "riskFreeRate": 0}
    result = prices_to_returns(rows, {"adjustment": "unadjusted"}, parameters, None)
    assert result["returns"] == pytest.approx([0.1, 0.1])
    assert result["dates"] == ["2020-01-03", "2020-01-06"]
    assert result["currency"] is None
    assert "TRADING_CALENDAR_UNVERIFIED" in result["limitations"]
    chinese = [{"日期": "2020-01-02", "收盘": "100"}, {"日期": "2020-01-03", "收盘": "110"}]
    assert prices_to_returns(chinese, {"adjustment": "unadjusted"},
                             {**parameters, "dateColumn": "日期", "priceColumn": "收盘"}, None)["returns"] == pytest.approx([0.1])


@pytest.mark.parametrize("with_calendar", [False, True])
def test_aktools_midnight_daily_labels_keep_the_provider_calendar_date(with_calendar):
    rows = [{"日期": "2025-01-06T00:00:00.000000000", "收盘": "121"},
            {"日期": "2025-01-02T00:00:00.000", "收盘": "100"},
            {"日期": "2025-01-03T00:00:00", "收盘": "110"}]
    calendar = [{"cal_date": row["日期"], "is_open": "1"} for row in rows] if with_calendar else None
    result = prices_to_returns(rows, {"adjustment": "unadjusted"},
        {"dateColumn": "日期", "priceColumn": "收盘", "returnBasis": "unadjusted-price-only", "riskFreeRate": 0}, calendar)
    assert result["dates"] == ["2025-01-03", "2025-01-06"]
    assert result["returns"] == pytest.approx([0.1, 0.1])
    assert result["calendarVerified"] is with_calendar
    assert rows[0]["日期"] == "2025-01-06T00:00:00.000000000"


def test_midnight_label_normalization_still_rejects_duplicate_price_dates():
    rows = [{"date": "2025-01-02", "close": "100"},
            {"date": "2025-01-02T00:00:00.000", "close": "110"}]
    with pytest.raises(ValueError, match="DUPLICATE_PRICE_DATE"):
        prices_to_returns(rows, {"adjustment": "unadjusted"},
            {"dateColumn": "date", "priceColumn": "close", "returnBasis": "unadjusted-price-only", "riskFreeRate": 0}, None)


@pytest.mark.parametrize("ambiguous", ["2025-01-02T12:00:00.000", "2025-01-02T00:00:00.001",
    "2025-01-02T00:00:00Z", "2025-01-02T00:00:00+08:00", "2025-01-02T00:00:00.000Z",
    "2025-01-02 00:00:00", "2025-02-30T00:00:00.000", "2025-01-02T00:00:00.000extra"])
def test_daily_price_labels_do_not_guess_intraday_timezone_or_invalid_dates(ambiguous):
    rows = [{"date": ambiguous, "close": "100"}, {"date": "2025-01-03", "close": "110"}]
    with pytest.raises(ValueError):
        prices_to_returns(rows, {"adjustment": "unadjusted"},
            {"dateColumn": "date", "priceColumn": "close", "returnBasis": "unadjusted-price-only", "riskFreeRate": 0}, None)


def test_missing_trading_session_or_price_is_not_filled_with_zero_or_bridged():
    calendar = [{"cal_date": "20200102", "is_open": "1"}, {"cal_date": "20200103", "is_open": "1"},
                {"cal_date": "20200106", "is_open": "1"}]
    rows = [{"date": "2020-01-02", "close": "100"}, {"date": "2020-01-06", "close": "121"}]
    result = prices_to_returns(rows, {"adjustment": "unadjusted"},
        {"dateColumn": "date", "priceColumn": "close", "returnBasis": "unadjusted-price-only", "riskFreeRate": 0}, calendar)
    assert result["returns"] == [None, None]
    assert result["endpointPriceChange"] == pytest.approx(0.21)
    assert result["calendarVerified"] is True


def test_adjustment_currency_unit_ambiguity_is_not_promoted_to_total_return():
    rows = [{"date": "2020-01-02", "close": "100"}, {"date": "2020-01-03", "close": "110"}]
    parameters = {"dateColumn": "date", "priceColumn": "close", "returnBasis": "total-return-index", "riskFreeRate": 0}
    with pytest.raises(ValueError, match="PRICE_ADJUSTMENT_BASIS"):
        prices_to_returns(rows, {"adjustment": "forward"}, parameters, None)
    with pytest.raises(ValueError, match="PRICE_ADJUSTMENT_BASIS"):
        prices_to_returns(rows, {"adjustment": "unknown"}, parameters, None)
    parameters.update(returnBasis="unadjusted-price-only", riskFreeRate=0.02)
    with pytest.raises(ValueError, match="CURRENCY_REQUIRED"):
        prices_to_returns(rows, {"adjustment": "unadjusted"}, parameters, None)
    rows[0]["_provenance"] = {"currency": "USD", "unit": "share-price"}
    rows[1]["_provenance"] = {"currency": "EUR", "unit": "share-price"}
    with pytest.raises(ValueError, match="PRICE_UNITS_CHANGED"):
        prices_to_returns(rows, {"adjustment": "unadjusted"}, parameters, None)
