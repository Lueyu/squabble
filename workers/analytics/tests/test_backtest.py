import copy
import pytest
from squabble_analytics.backtest import run_backtest
from squabble_analytics.market_rules import settled_quantity


def fixture():
    dates = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07", "2020-01-08"]
    parameters = {"templateId": "fixed-shares-v1", "instrumentId": "DEMO", "quantity": 10,
                  "initialCash": 1000, "baseCurrency": "USD", "from": dates[0], "to": dates[-1],
                  "signalDate": dates[0], "signalAvailableAt": dates[0] + "T21:00:00Z",
                  "universeVersionId": "universe-2020", "universeCoverage": "historical",
                  "calendar": {"versionId": "calendar-2020", "coveredYears": [2020], "sessions": dates,
                               "decisionAt": {day: day + "T21:00:00Z" for day in dates}},
                  "marketRules": {"versionId": "rules-2020", "effectiveFrom": dates[0], "effectiveTo": dates[-1],
                                  "lotSize": 1, "settlementSessions": 0, "commissionRate": 0,
                                  "minimumCommission": 0, "sellTaxRate": 0, "dividendTaxRate": 0,
                                  "slippageBps": 0, "feeCurrency": "USD", "allowOddLotLiquidation": False},
                  "corporateActionsVersionId": "actions-2020", "corporateActions": [],
                  "fxVersionId": "fx-2020", "fxRates": [], "cashFlows": [],
                  "benchmark": {"datasetVersionId": "benchmark-2020", "returnColumn": "return"},
                  "benchmarkReturns": [0] * len(dates), "frequency": "daily", "annualizationFactor": 252, "riskFreeRate": 0,
                  "outOfSampleFrom": dates[-1]}
    rows = [{"instrumentId": "DEMO", "date": date, "availableAt": date + "T21:00:00Z",
             "open": 50, "high": 50, "low": 50, "close": 50, "volume": 1000,
             "currency": "USD", "adjustment": "unadjusted", "halted": False,
             "limitUp": False, "limitDown": False} for date in dates]
    return parameters, rows


def test_next_tradable_session_fills_not_signal_close():
    parameters, rows = fixture()
    rows[1].update(open=60, high=60, low=60, close=60)
    result = run_backtest(parameters, rows)
    assert result["trades"][0]["date"] == "2020-01-03"
    assert result["trades"][0]["basePrice"] == 60
    assert result["engine"]["preload"] is False
    assert result["engine"]["runonce"] is False
    assert result["engine"]["cheatOnClose"] is False


def test_announcement_not_visible_before_available_at():
    parameters, rows = fixture()
    parameters["signalAvailableAt"] = "2020-01-06T21:00:00Z"
    assert run_backtest(parameters, rows)["trades"][0]["date"] == "2020-01-07"
    parameters["signalAvailableAt"] = "2020-01-02T22:00:00Z"
    assert run_backtest(parameters, rows)["trades"][0]["date"] == "2020-01-06"


def test_split_and_dividend_conserve_units_and_cash_without_adjusted_execution_prices():
    parameters, rows = fixture()
    parameters["corporateActions"] = [{"date": "2020-01-06", "type": "split", "ratio": 2},
                                      {"date": "2020-01-07", "type": "dividend", "amount": 1, "currency": "USD"}]
    for row in rows[2:]: row.update(open=25, high=25, low=25, close=25)
    result = run_backtest(parameters, rows)
    assert result["finalQuantity"] == 20
    assert result["finalCash"] == pytest.approx(520)
    assert result["nav"][-1]["value"] == pytest.approx(1020)
    rows[0]["adjustment"] = "forward"
    with pytest.raises(ValueError, match="UNADJUSTED"):
        run_backtest(parameters, rows)


def test_halted_and_limit_up_sessions_never_fill_orders():
    parameters, rows = fixture()
    rows[1]["halted"] = True
    rows[2]["limitUp"] = True
    result = run_backtest(parameters, rows)
    assert result["trades"][0]["date"] == "2020-01-07"
    assert {row["reason"] for row in result["blocked"]} == {"HALTED", "LIMIT_UP"}


def test_t_plus_one_inventory_and_board_lot_are_explicit():
    assert settled_quantity([{"date": "2020-01-03", "quantity": 100}], "2020-01-03",
                            ["2020-01-03", "2020-01-06"], 1) == 0
    assert settled_quantity([{"date": "2020-01-03", "quantity": 100}], "2020-01-06",
                            ["2020-01-03", "2020-01-06"], 1) == 100
    parameters, rows = fixture()
    parameters["marketRules"]["lotSize"] = 100
    with pytest.raises(ValueError, match="BOARD_LOT"):
        run_backtest(parameters, rows)


def test_minimum_commission_is_in_cash_and_auditable_trade():
    parameters, rows = fixture()
    parameters["marketRules"]["minimumCommission"] = 2
    result = run_backtest(parameters, rows)
    assert result["trades"][0]["commission"] == 2
    assert result["finalCash"] == 498
    assert result["nav"][-1]["value"] == 998


def test_matching_date_fx_is_required_and_changes_base_currency_nav():
    parameters, rows = fixture()
    for row in rows: row["currency"] = "EUR"
    with pytest.raises(ValueError, match="FX_MISSING"):
        run_backtest(parameters, rows)
    parameters["fxRates"] = [{"date": row["date"], "from": "EUR", "to": "USD", "rate": 2} for row in rows]
    result = run_backtest(parameters, rows)
    assert result["trades"][0]["basePrice"] == 100
    assert result["finalQuantity"] == 10


def test_external_cash_flow_is_not_investment_return():
    parameters, rows = fixture()
    parameters["cashFlows"] = [{"date": "2020-01-06", "amount": 500, "currency": "USD", "timing": "before_open"}]
    result = run_backtest(parameters, rows)
    assert result["nav"][-1]["value"] == 1500
    assert result["nav"][2]["return"] == pytest.approx(0)
    assert result["cashFlows"][0]["baseAmount"] == 500


def test_calendar_cannot_infer_missing_historical_year_or_missing_sessions():
    parameters, rows = fixture()
    parameters["calendar"]["coveredYears"] = [2026]
    with pytest.raises(ValueError, match="CALENDAR_YEAR"):
        run_backtest(parameters, rows)
    parameters, rows = fixture()
    with pytest.raises(ValueError, match="SESSION_COVERAGE"):
        run_backtest(parameters, rows[:2])


def test_current_universe_discloses_survivorship_and_free_code_is_never_validated():
    parameters, rows = fixture()
    parameters["universeCoverage"] = "current"
    result = run_backtest(parameters, rows)
    assert result["universeLabel"] == "current-universe"
    assert "SURVIVORSHIP_COVERAGE_UNKNOWN" in result["coverage"]["missing"]
    parameters["universeMember"] = {"instrumentId": "DEMO", "listedAt": "2019-01-01", "delistedAt": "2020-01-06"}
    with pytest.raises(ValueError, match="DELISTING_ACCOUNTING_UNSUPPORTED"):
        run_backtest(parameters, rows)
    parameters.pop("universeMember")
    parameters["templateId"] = "custom-python"
    with pytest.raises(ValueError, match="FIXED_TEMPLATE"):
        run_backtest(parameters, rows)
