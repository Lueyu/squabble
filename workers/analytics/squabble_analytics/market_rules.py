"""Small market-rule adapter around Backtrader; not a replacement matching engine."""


def settled_quantity(lots, current_date, sessions, settlement_sessions):
    today = sessions.index(current_date)
    return sum(lot["quantity"] for lot in lots
               if today - sessions.index(lot["date"]) >= settlement_sessions)


def fx_rate(parameters, currency, current_date):
    if currency == parameters["baseCurrency"]:
        return 1.0
    found = [rate["rate"] for rate in parameters["fxRates"]
             if rate["date"] == current_date and rate["from"] == currency and rate["to"] == parameters["baseCurrency"]]
    if len(found) != 1 or found[0] <= 0:
        raise ValueError("FX_MISSING_OR_AMBIGUOUS")
    return float(found[0])
