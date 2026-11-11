"""Trusted event-time validation. Report periods never substitute for availableAt."""
from datetime import datetime, date
from math import isfinite


def instant(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed
    except (ValueError, TypeError, AttributeError):
        raise ValueError("AVAILABLE_AT_REQUIRED") from None


def visible_rows(rows, decision_at):
    cutoff = instant(decision_at)
    return [row for row in rows if instant(row.get("availableAt")) <= cutoff]


def validate_inputs(parameters, rows):
    if parameters.get("templateId") not in {"fixed-shares-v1", "moving-average-v1"}:
        raise ValueError("FIXED_TEMPLATE_REQUIRED")
    for name in ["universeVersionId", "corporateActionsVersionId", "fxVersionId", "baseCurrency", "instrumentId"]:
        if not parameters.get(name):
            raise ValueError("BACKTEST_VERSION_REQUIRED")
    if parameters.get("universeCoverage") not in {"historical", "current"}:
        raise ValueError("UNIVERSE_COVERAGE_REQUIRED")
    member = parameters.get("universeMember")
    if member is not None:
        if not member.get("listedAt") or member["listedAt"] > parameters["from"]:
            raise ValueError("LISTING_POOL_COVERAGE_REQUIRED")
        if member.get("delistedAt") and member["delistedAt"] <= parameters["to"]:
            raise ValueError("DELISTING_ACCOUNTING_UNSUPPORTED")
    start, end = date.fromisoformat(parameters["from"]), date.fromisoformat(parameters["to"])
    calendar = parameters.get("calendar", {})
    if not calendar.get("versionId") or not set(range(start.year, end.year + 1)) <= set(calendar.get("coveredYears", [])):
        raise ValueError("CALENDAR_YEAR_COVERAGE_REQUIRED")
    sessions = calendar.get("sessions", [])
    if sessions != sorted(set(sessions)) or not sessions or sessions[0] != start.isoformat() or sessions[-1] != end.isoformat():
        raise ValueError("CALENDAR_SESSION_COVERAGE_REQUIRED")
    if [row.get("date") for row in rows] != sessions:
        raise ValueError("PRICE_SESSION_COVERAGE_REQUIRED")
    for session in sessions:
        instant(calendar.get("decisionAt", {}).get(session))
    rules = parameters.get("marketRules", {})
    if not rules.get("versionId") or rules.get("effectiveFrom", "9999") > parameters["from"] or rules.get("effectiveTo", "") < parameters["to"]:
        raise ValueError("MARKET_RULE_EFFECTIVE_DATES_REQUIRED")
    for key in ["lotSize", "settlementSessions", "commissionRate", "minimumCommission", "sellTaxRate", "dividendTaxRate", "slippageBps"]:
        value = rules.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value < 0:
            raise ValueError("MARKET_RULE_REQUIRED")
    if rules["lotSize"] < 1 or not isinstance(rules["settlementSessions"], int):
        raise ValueError("MARKET_RULE_REQUIRED")
    if not rules.get("feeCurrency") or not isinstance(rules.get("allowOddLotLiquidation"), bool):
        raise ValueError("MARKET_RULE_FEE_CURRENCY_OR_ODD_LOT_REQUIRED")
    quantity = parameters.get("quantity")
    if not isinstance(quantity, int) or quantity <= 0 or quantity % rules["lotSize"]:
        raise ValueError("BOARD_LOT_REQUIRED")
    if parameters.get("frequency") != "daily" or not isinstance(parameters.get("annualizationFactor"), int) or parameters["annualizationFactor"] < 1:
        raise ValueError("ANNUALIZATION_REQUIRED")
    if not isinstance(parameters.get("riskFreeRate"), (int, float)) or not isfinite(parameters["riskFreeRate"]):
        raise ValueError("RISK_FREE_RATE_REQUIRED")
    benchmark = parameters.get("benchmark", {})
    if not benchmark.get("datasetVersionId") or not benchmark.get("returnColumn"):
        raise ValueError("BENCHMARK_REQUIRED")
    if len(parameters.get("benchmarkReturns", [])) != len(sessions) or any(value is None for value in parameters["benchmarkReturns"]):
        raise ValueError("BENCHMARK_COVERAGE_REQUIRED")
    instant(parameters.get("signalAvailableAt"))
    if parameters.get("exitSignalDate"):
        instant(parameters.get("exitAvailableAt"))
    if not parameters.get("outOfSampleFrom") or parameters["outOfSampleFrom"] not in sessions:
        raise ValueError("OUT_OF_SAMPLE_REQUIRED")
    for row in rows:
        if row.get("instrumentId") != parameters["instrumentId"] or row.get("adjustment") != "unadjusted":
            raise ValueError("UNADJUSTED_EXECUTION_PRICES_REQUIRED")
        instant(row.get("availableAt"))
        if not row.get("currency") or any(not isinstance(row.get(key), bool) for key in ["halted", "limitUp", "limitDown"]):
            raise ValueError("MARKET_STATUS_REQUIRED")
        for key in ["open", "high", "low", "close", "volume"]:
            number = row.get(key)
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not isfinite(number) or number < 0 or key != "volume" and number == 0:
                raise ValueError("RAW_PRICE_REQUIRED")
    return parameters
