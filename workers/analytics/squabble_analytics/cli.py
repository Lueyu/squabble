"""File-only worker entrypoint. Run untrusted code only inside the configured E2B template."""
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import random

import numpy as np
import pandas as pd

from . import __version__
from .backtest import run_backtest
from .charts import returns_chart
from .manifest import load_inputs, validate_manifest
from .statistics import summarize_returns
from .prices import prices_to_returns


def _number(value):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("NUMERIC_VALUE_REQUIRED")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("NUMERIC_VALUE_REQUIRED")
    return number


def _backtest_parameters(manifest, inputs):
    parameters = dict(manifest["parameters"])
    by_id = {dataset["datasetVersionId"]: (dataset, rows)
             for dataset, rows in zip(manifest["datasets"], inputs, strict=True)}
    required = [parameters[key] for key in ["priceDatasetVersionId", "universeVersionId", "calendarVersionId",
                "marketRulesVersionId", "corporateActionsVersionId", "fxVersionId"]]
    required.append(parameters["benchmark"]["datasetVersionId"])
    if parameters.get("cashFlowDatasetVersionId"):
        required.append(parameters["cashFlowDatasetVersionId"])
    if any(key not in by_id for key in required):
        raise ValueError("BACKTEST_DATASET_VERSION_REQUIRED")
    for key in required:
        if by_id[key][0].get("coverage", {}).get("status") != "complete":
            raise ValueError("BACKTEST_SOURCE_COVERAGE_REQUIRED")
    calendar_rows = by_id[parameters["calendarVersionId"]][1]
    sessions = [row["date"] for row in calendar_rows if row.get("type") == "session"
                and parameters["from"] <= row["date"] <= parameters["to"]]
    years = [row["year"] for row in calendar_rows if row.get("type") == "coverage" and row.get("complete") is True]
    parameters["calendar"] = {"versionId": parameters["calendarVersionId"], "sessions": sessions, "coveredYears": years,
                              "decisionAt": {row["date"]: row["closeAt"] for row in calendar_rows
                                             if row.get("type") == "session" and row["date"] in sessions}}
    rules = [row for row in by_id[parameters["marketRulesVersionId"]][1]
             if row["effectiveFrom"] <= parameters["from"] and row["effectiveTo"] >= parameters["to"]]
    if len(rules) != 1:
        raise ValueError("MARKET_RULE_EFFECTIVE_DATES_REQUIRED")
    parameters["marketRules"] = {**rules[0], "versionId": parameters["marketRulesVersionId"]}
    for key in ["lotSize", "settlementSessions", "commissionRate", "minimumCommission", "sellTaxRate", "dividendTaxRate", "slippageBps"]:
        value = _number(parameters["marketRules"][key])
        parameters["marketRules"][key] = int(value) if key in {"lotSize", "settlementSessions"} and value.is_integer() else value
    parameters["corporateActions"] = [dict(row) for row in by_id[parameters["corporateActionsVersionId"]][1]]
    for row in parameters["corporateActions"]:
        for key in ["ratio", "amount"]:
            if key in row:
                row[key] = _number(row[key])
    parameters["fxRates"] = [{**row, "rate": _number(row["rate"])} for row in by_id[parameters["fxVersionId"]][1]]
    parameters["cashFlows"] = [] if parameters.get("cashFlowDatasetVersionId") is None else [
        {**row, "amount": _number(row["amount"])} for row in by_id[parameters["cashFlowDatasetVersionId"]][1]]
    universe_metadata, members = by_id[parameters["universeVersionId"]]
    selected = [row for row in members if row.get("instrumentId") == parameters["instrumentId"]]
    if len(selected) != 1:
        raise ValueError("INSTRUMENT_NOT_IN_FROZEN_UNIVERSE")
    parameters["universeMember"] = selected[0]
    parameters["universeCoverage"] = universe_metadata.get("schema", {}).get("universeCoverage")
    benchmark = by_id[parameters["benchmark"]["datasetVersionId"]][1]
    if [row["date"] for row in benchmark] != sessions:
        raise ValueError("BENCHMARK_SESSION_COVERAGE_REQUIRED")
    parameters["benchmarkReturns"] = [_number(row[parameters["benchmark"]["returnColumn"]]) for row in benchmark]
    price_metadata, prices = by_id[parameters["priceDatasetVersionId"]]
    if price_metadata.get("adjustment") != "unadjusted":
        raise ValueError("UNADJUSTED_EXECUTION_PRICES_REQUIRED")
    prices = [row for row in prices if row.get("instrumentId") == parameters["instrumentId"]
              and parameters["from"] <= row["date"] <= parameters["to"]]
    for row in prices:
        for key in ["open", "high", "low", "close", "volume"]:
            row[key] = _number(row[key])
    return parameters, prices


def run(manifest_path):
    path = Path(manifest_path).resolve()
    manifest = validate_manifest(json.loads(path.read_text(encoding="utf-8")))
    inputs = load_inputs(manifest, path.parent)
    dependencies = manifest["dependencies"]
    if dependencies.get("worker") != __version__ or dependencies.get("python") != platform.python_version():
        raise ValueError("WORKER_DEPENDENCY_MISMATCH")
    for name in ["quantstats", "pandas", "numpy", "matplotlib", "backtrader"]:
        if dependencies.get(name) != importlib.metadata.version(name):
            raise ValueError("WORKER_DEPENDENCY_MISMATCH")
    code = (path.parent / "code.py").read_bytes()
    if hashlib.sha256(code).hexdigest() != manifest["codeHash"]:
        raise ValueError("CODE_HASH_MISMATCH")
    if manifest["kind"] != "exploratory" and code != f'# Squabble fixed template {manifest["templateId"]} version 1\n'.encode():
        raise ValueError("FIXED_TEMPLATE_CODE_REQUIRED")
    random.seed(manifest["seed"])
    np.random.seed(manifest["seed"])
    output = path.parent / "outputs"
    output.mkdir(exist_ok=True)
    parameters = manifest["parameters"]
    if manifest["kind"] == "statistics":
        prices = None
        if parameters.get("inputKind") == "prices":
            calendar = None
            calendar_id = parameters["calendarDatasetVersionId"]
            if calendar_id:
                matching = [(dataset, rows) for dataset, rows in zip(manifest["datasets"], inputs, strict=True)
                            if dataset["datasetVersionId"] == calendar_id]
                if len(matching) != 1 or matching[0][0].get("coverage", {}).get("status") != "complete":
                    raise ValueError("PRICE_CALENDAR_DATASET_REQUIRED")
                calendar = matching[0][1]
            prices = prices_to_returns(inputs[0], manifest["datasets"][0], parameters, calendar)
            values, benchmark = prices["returns"], None
        else:
            values = [_number(row[parameters["returnColumn"]]) for row in inputs[0]]
            benchmark = None if parameters["benchmarkColumn"] is None else [_number(row[parameters["benchmarkColumn"]]) for row in inputs[0]]
        result = summarize_returns(values, periods_per_year=parameters["annualizationFactor"],
                                   risk_free_rate=parameters["riskFreeRate"], frequency=parameters["frequency"], benchmark=benchmark)
        if prices is not None:
            result.update(templateId="prices-to-returns-v1", priceEvidence={key: value for key, value in prices.items()
                                                                          if key not in {"returns", "dates"}})
            if not prices["calendarVerified"]:
                for key in ["annualizedReturn", "annualizedVolatility", "sharpe", "sortino"]:
                    result[key] = None
                result["coverage"] = "partial"
            if any(value is None for value in values):
                result["totalReturn"] = None
                result["maxDrawdown"] = None
            pd.DataFrame({"date": prices["dates"], "return": values}).to_csv(output / "returns.csv", index=False)
        else:
            pd.DataFrame({"return": values}).to_csv(output / "returns.csv", index=False)
        returns_chart(values, output / "returns.png")
    elif manifest["kind"] == "backtest":
        backtest_parameters, prices = _backtest_parameters(manifest, inputs)
        result = run_backtest(backtest_parameters, prices)
        pd.DataFrame(result["nav"]).to_csv(output / "nav.csv", index=False)
        pd.DataFrame(result["trades"]).to_csv(output / "trades.csv", index=False)
        returns_chart([row["return"] for row in result["nav"]], output / "returns.png")
    else:
        namespace = {"datasets": inputs, "parameters": parameters, "seed": manifest["seed"],
                     "output_dir": str(output), "result": None}
        exec(compile(code, "exploratory-code.py", "exec"), namespace)
        result = {"classification": "exploratory", "result": namespace["result"]}
    (output / "result.json").write_text(json.dumps(result, allow_nan=False, ensure_ascii=False), encoding="utf-8")
    allowed = {".json": "application/json", ".csv": "text/csv", ".png": "image/png", ".txt": "text/plain"}
    files = []
    total = 0
    for artifact in sorted(output.iterdir()):
        if artifact.name == "outputs.json":
            continue
        if not artifact.is_file() or artifact.is_symlink() or artifact.suffix not in allowed:
            raise ValueError("OUTPUT_PATH_OR_TYPE_INVALID")
        data = artifact.read_bytes()
        total += len(data)
        if total > manifest["limits"]["maxOutputBytes"] or len(files) >= 8:
            raise ValueError("OUTPUT_LIMIT")
        files.append({"name": artifact.name, "mime": allowed[artifact.suffix], "sizeBytes": len(data),
                      "sha256": hashlib.sha256(data).hexdigest()})
    (output / "outputs.json").write_text(json.dumps({"files": files}), encoding="utf-8")


if __name__ == "__main__":
    import sys
    run(sys.argv[1])
