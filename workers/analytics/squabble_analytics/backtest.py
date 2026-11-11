"""Reviewed fixed strategies on Backtrader's event engine, isolated from the app ledger.

GPL-3.0-or-later. No custom model-authored code enters this validated runner.
"""
from datetime import datetime
import copy
import backtrader as bt
import pandas as pd

from .point_in_time import instant, validate_inputs
from .market_rules import fx_rate, settled_quantity
from .statistics import summarize_returns

ENGINE_CONFIG = {"name": "Backtrader", "version": "1.9.78.123", "preload": False,
                 "runonce": False, "cheatOnClose": False, "cheatOnOpen": False}


class AuditedCommission(bt.CommInfoBase):
    params = (("commission", 0), ("minimum", 0), ("sell_tax", 0),
              ("audit_context", None),
              ("stocklike", True), ("commtype", bt.CommInfoBase.COMM_PERC), ("percabs", True))

    def _getcommission(self, size, price, pseudoexec):
        notional = abs(size) * price
        context = self.p.audit_context
        current = context["data"].datetime.date(0).isoformat()
        minimum = self.p.minimum * fx_rate(context["parameters"], context["parameters"]["marketRules"]["feeCurrency"], current)
        return max(minimum, notional * self.p.commission) + (notional * self.p.sell_tax if size < 0 else 0)


class AuditedBroker(bt.brokers.BackBroker):
    params = (("audit_context", None),)

    def next(self):
        context = self.p.audit_context
        data = context["data"]
        if len(data):
            current = data.datetime.date(0).isoformat()
            if current not in context["applied"]:
                context["applied"].add(current)
                for action in context["parameters"]["corporateActions"]:
                    if action["date"] != current:
                        continue
                    position = self.getposition(data)
                    if action["type"] == "split":
                        ratio = action["ratio"]
                        size = position.size * ratio
                        if size != int(size):
                            raise ValueError("FRACTIONAL_CORPORATE_ACTION_POLICY_REQUIRED")
                        if position.size:
                            position.fix(size, position.price / ratio)
                        for lot in context["lots"]:
                            lot["quantity"] *= ratio
                        # Unfilled orders crossing an action are cancelled explicitly; no guessed adjustment.
                        for order in list(self.pending):
                            if order is not None:
                                self.cancel(order)
                        context["ledger"].append({"date": current, "kind": "split", "ratio": ratio, "quantity": size})
                    elif action["type"] == "dividend":
                        amount = position.size * action["amount"] * fx_rate(context["parameters"], action["currency"], current)
                        amount *= 1 - context["parameters"]["marketRules"]["dividendTaxRate"]
                        self.add_cash(amount)
                        context["ledger"].append({"date": current, "kind": "dividend", "baseAmount": amount})
                    else:
                        raise ValueError("CORPORATE_ACTION_UNSUPPORTED")
                for flow in context["parameters"]["cashFlows"]:
                    if flow["date"] == current:
                        if flow.get("timing") != "before_open":
                            raise ValueError("CASH_FLOW_TIMING_REQUIRED")
                        amount = flow["amount"] * fx_rate(context["parameters"], flow["currency"], current)
                        self.add_cash(amount)
                        context["flows"].append({**flow, "baseAmount": amount})
        super().next()

    def _try_exec(self, order):
        context = self.p.audit_context
        current = order.data.datetime.date(0).isoformat()
        row = context["rows"][current]
        reason = "HALTED" if row["halted"] else "LIMIT_UP" if order.isbuy() and row["limitUp"] else "LIMIT_DOWN" if order.issell() and row["limitDown"] else None
        if reason is None and order.issell() and abs(order.executed.remsize) > settled_quantity(context["lots"], current,
                context["parameters"]["calendar"]["sessions"], context["parameters"]["marketRules"]["settlementSessions"]):
            reason = "UNSETTLED_INVENTORY"
        rules = context["parameters"]["marketRules"]
        odd_lot = abs(order.executed.remsize) % rules["lotSize"]
        if reason is None and odd_lot and not (order.issell() and rules["allowOddLotLiquidation"]
                and abs(order.executed.remsize) == self.getposition(order.data).size):
            reason = "BOARD_LOT"
        if reason is None and abs(order.executed.remsize) > row["volume"]:
            reason = "VOLUME_LIMIT"
        if reason:
            context["blocked"].append({"date": current, "reason": reason})
            return
        super()._try_exec(order)


class FixedReviewedStrategy(bt.Strategy):
    params = (("audit_context", None),)

    def __init__(self):
        self.pending = None
        self.entered = False
        self.exited = False
        self.closes = []

    def notify_order(self, order):
        if order.status == order.Completed:
            context = self.p.audit_context
            current = self.data.datetime.date(0).isoformat()
            context["trades"].append({"date": current, "quantity": order.executed.size,
                                      "basePrice": order.executed.price, "commission": order.executed.comm,
                                      "executionBasis": "next tradable session unadjusted open, converted at session FX"})
            if order.isbuy():
                context["lots"].append({"date": current, "quantity": order.executed.size})
                self.entered = True
            else:
                remaining = abs(order.executed.size)
                for lot in context["lots"]:
                    taken = min(remaining, lot["quantity"])
                    lot["quantity"] -= taken
                    remaining -= taken
                self.exited = True
        if order.status in [order.Completed, order.Canceled, order.Margin, order.Rejected]:
            self.pending = None

    def next(self):
        context = self.p.audit_context
        parameters = context["parameters"]
        current = self.data.datetime.date(0).isoformat()
        row = context["rows"][current]
        decision_at = parameters["calendar"]["decisionAt"][current]
        value = self.broker.getvalue()
        flow = sum(item["baseAmount"] for item in context["flows"] if item["date"] == current)
        denominator = context["previous_nav"] + flow
        period_return = (value - context["previous_nav"] - flow) / denominator if denominator else None
        context["nav"].append({"date": current, "value": value, "externalFlow": flow, "return": period_return})
        context["previous_nav"] = value
        if self.pending or instant(row["availableAt"]) > instant(decision_at):
            return
        self.closes.append(float(self.data.close[0]))
        entry_visible = current >= parameters["signalDate"] and instant(parameters["signalAvailableAt"]) <= instant(decision_at)
        if parameters["templateId"] == "moving-average-v1":
            window = parameters.get("window")
            if not isinstance(window, int) or not 2 <= window <= 200:
                raise ValueError("MOVING_AVERAGE_WINDOW_REQUIRED")
            entry_visible = entry_visible and len(self.closes) >= window and self.closes[-1] > sum(self.closes[-window:]) / window
        if not self.entered and not self.exited and entry_visible:
            self.pending = self.buy(size=parameters["quantity"])
        elif self.entered and not self.exited and parameters.get("exitSignalDate") and current >= parameters["exitSignalDate"] and instant(parameters["exitAvailableAt"]) <= instant(decision_at):
            self.pending = self.sell(size=self.position.size)


def run_backtest(parameters, rows):
    parameters, rows = copy.deepcopy(parameters), copy.deepcopy(rows)
    validate_inputs(parameters, rows)
    indexed = {row["date"]: row for row in rows}
    frame = pd.DataFrame(rows)
    for i, row in enumerate(rows):
        rate = fx_rate(parameters, row["currency"], row["date"])
        for key in ["open", "high", "low", "close"]:
            frame.loc[i, key] = row[key] * rate
    frame.index = pd.to_datetime(frame["date"])
    context = {"parameters": parameters, "rows": indexed, "trades": [], "nav": [], "lots": [], "applied": set(),
               "ledger": [], "flows": [], "blocked": [], "previous_nav": parameters["initialCash"]}
    cerebro = bt.Cerebro(stdstats=False, preload=False, runonce=False, cheat_on_open=False)
    data = bt.feeds.PandasData(dataname=frame, datetime=None, openinterest=-1)
    context["data"] = data
    cerebro.adddata(data)
    broker = AuditedBroker(audit_context=context)
    broker.setcash(parameters["initialCash"])
    broker.set_coc(False)
    broker.set_coo(False)
    rules = parameters["marketRules"]
    broker.addcommissioninfo(AuditedCommission(commission=rules["commissionRate"], minimum=rules["minimumCommission"],
                                             sell_tax=rules["sellTaxRate"], audit_context=context))
    broker.set_slippage_perc(rules["slippageBps"] / 10000, slip_open=True, slip_match=True, slip_out=False)
    cerebro.setbroker(broker)
    cerebro.addstrategy(FixedReviewedStrategy, audit_context=context)
    cerebro.run(preload=False, runonce=False)
    returns = [row["return"] for row in context["nav"]]
    missing = ["SURVIVORSHIP_COVERAGE_UNKNOWN"] if parameters["universeCoverage"] == "current" else []
    return {"classification": "hypothetical-validated-template-backtest", "templateId": parameters["templateId"],
            "templateVersion": "1", "engine": ENGINE_CONFIG, "trades": context["trades"], "nav": context["nav"],
            "finalCash": broker.getcash(), "finalQuantity": broker.getposition(data).size,
            "cashFlows": context["flows"], "corporateActionLedger": context["ledger"], "blocked": context["blocked"],
            "coverage": {"status": "partial" if missing else "complete", "missing": missing},
            "universeLabel": "current-universe" if missing else "historical-universe",
            "outOfSampleFrom": parameters["outOfSampleFrom"],
            "statistics": summarize_returns(returns, periods_per_year=parameters["annualizationFactor"],
                                            risk_free_rate=parameters["riskFreeRate"], frequency=parameters["frequency"],
                                            benchmark=parameters["benchmarkReturns"])}
