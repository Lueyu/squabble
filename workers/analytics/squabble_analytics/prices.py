"""Fixed, explicit price-to-return conversion; raw price levels are never returns."""
from datetime import date
from math import isfinite


def _field(row, path):
    current = row
    for name in path.split("."):
        if name in {"__proto__", "constructor", "prototype"} or not isinstance(current, dict):
            raise ValueError("PRICE_COLUMN_INVALID")
        current = current.get(name)
    return current


def _day(value):
    text = str(value)
    if len(text) == 8 and text.isdigit():
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return date.fromisoformat(text).isoformat()


def prices_to_returns(rows, metadata, parameters, calendar_rows):
    adjustment = metadata.get("adjustment")
    expected = {"unadjusted": "unadjusted-price-only", "forward": "provider-adjusted-price",
                "backward": "provider-adjusted-price", "total_return": "total-return-index"}.get(adjustment)
    if expected is None or parameters.get("returnBasis") != expected:
        raise ValueError("PRICE_ADJUSTMENT_BASIS_MISMATCH")
    by_date = {}
    currencies, units = [], []
    for row in rows:
        day = _day(_field(row, parameters["dateColumn"]))
        if day in by_date:
            raise ValueError("DUPLICATE_PRICE_DATE")
        value = _field(row, parameters["priceColumn"])
        number = None if value is None or value == "" else float(value)
        if number is not None and (not isfinite(number) or number <= 0):
            raise ValueError("PRICE_VALUE_INVALID")
        by_date[day] = number
        provenance = row.get("_provenance", {})
        currencies.append(row.get("currency") or provenance.get("currency"))
        units.append(row.get("unit") or provenance.get("unit"))
    if len(by_date) < 2:
        raise ValueError("PRICE_HISTORY_TOO_SHORT")
    if len({value for value in currencies if value}) > 1 or len({value for value in units if value}) > 1:
        raise ValueError("PRICE_UNITS_CHANGED")
    currency = currencies[0] if currencies and all(value == currencies[0] and value for value in currencies) else None
    unit = units[0] if units and all(value == units[0] and value for value in units) else None
    if parameters["riskFreeRate"] != 0 and currency is None:
        raise ValueError("CURRENCY_REQUIRED_FOR_NONZERO_RISK_FREE_RATE")
    dates = sorted(by_date)
    verified = calendar_rows is not None
    if verified:
        date_column = parameters.get("calendarDateColumn", "cal_date")
        open_column = parameters.get("calendarOpenColumn", "is_open")
        sessions = sorted({_day(_field(row, date_column)) for row in calendar_rows
                           if str(_field(row, open_column)).lower() in {"1", "true"}})
        if any(day not in sessions for day in dates):
            raise ValueError("PRICE_CALENDAR_MISMATCH")
        dates = [day for day in sessions if dates[0] <= day <= dates[-1]]
    values = [by_date.get(day) for day in dates]
    returns = [None if left is None or right is None else right / left - 1
               for left, right in zip(values, values[1:])]
    limitations = []
    if not verified:
        limitations.append("TRADING_CALENDAR_UNVERIFIED")
    if currency is None:
        limitations.append("PRICE_CURRENCY_UNKNOWN")
    if unit is None:
        limitations.append("PRICE_UNIT_UNKNOWN")
    if adjustment == "unadjusted":
        limitations.append("PRICE_ONLY_EXCLUDES_DIVIDENDS_AND_SPLIT_ADJUSTMENT")
    elif adjustment != "total_return":
        limitations.append("PROVIDER_ADJUSTMENT_NOT_VERIFIED_TOTAL_RETURN")
    return {"returns": returns, "dates": dates[1:], "calendarVerified": verified,
            "currency": currency, "unit": unit, "returnBasis": expected, "sourceAdjustment": adjustment,
            "endpointPriceChange": values[-1] / values[0] - 1 if values[0] is not None and values[-1] is not None else None,
            "limitations": limitations}
