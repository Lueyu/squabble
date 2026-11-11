import hashlib
import importlib.metadata
import json
import platform
from pathlib import Path
from uuid import uuid4

import pytest

from squabble_analytics.cli import run


def test_full_local_statistics_pipeline_saves_verified_artifacts_and_missing_rows(tmp_path):
    rows = [{"return": "0.1", "benchmark": "0.0"}, {"return": None, "benchmark": "0.0"},
            {"return": "-0.1", "benchmark": "0.0"}]
    raw = json.dumps(rows).encode()
    code = b"# Squabble fixed template returns-v1 version 1\n"
    (tmp_path / "dataset-0.json").write_bytes(raw)
    (tmp_path / "code.py").write_bytes(code)
    manifest = {"version": 1, "kind": "statistics", "templateId": "returns-v1", "templateVersion": "1",
                "codeHash": hashlib.sha256(code).hexdigest(), "codePath": "code.py", "seed": 7,
                "parameters": {"returnColumn": "return", "benchmarkColumn": "benchmark", "frequency": "daily",
                               "annualizationFactor": 252, "riskFreeRate": 0},
                "effectiveDataClasses": ["portfolio"], "permittedUses": ["research", "egress:e2b"],
                "dependencies": {"worker": "1.0.0", "python": platform.python_version(),
                                 **{name: importlib.metadata.version(name) for name in ["quantstats", "pandas", "numpy", "matplotlib", "backtrader"]}},
                "limits": {"maxOutputBytes": 1000000},
                "datasets": [{"datasetVersionId": "fixture", "contentHash": "a" * 64, "path": "dataset-0.json",
                              "fileSha256": hashlib.sha256(raw).hexdigest(), "rowCount": 3,
                              "dataClasses": ["portfolio"], "permittedUses": ["research", "egress:e2b"]}]}
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    run(str(manifest_path))
    outputs = json.loads((tmp_path / "outputs" / "outputs.json").read_text())
    assert {file["name"] for file in outputs["files"]} == {"result.json", "returns.csv", "returns.png"}
    for file in outputs["files"]:
        value = (tmp_path / "outputs" / file["name"]).read_bytes()
        assert len(value) == file["sizeBytes"]
        assert hashlib.sha256(value).hexdigest() == file["sha256"]
    result = json.loads((tmp_path / "outputs" / "result.json").read_text())
    assert result["missingPeriods"] == 1
    assert result["positivePeriodRatio"] == 0.5


def test_full_backtest_cli_resolves_market_inputs_from_complete_versioned_files(tmp_path):
    dates = ["2020-01-02", "2020-01-03", "2020-01-06"]
    ids = {name: str(uuid4()) for name in ["prices", "calendar", "rules", "universe", "actions", "fx", "benchmark"]}
    parameters = {"templateId": "fixed-shares-v1", "instrumentId": "DEMO", "quantity": 1, "initialCash": 100,
                  "baseCurrency": "USD", "from": dates[0], "to": dates[-1], "signalDate": dates[0],
                  "signalAvailableAt": dates[0] + "T21:00:00Z", "outOfSampleFrom": dates[-1],
                  "universeVersionId": ids["universe"], "priceDatasetVersionId": ids["prices"],
                  "calendarVersionId": ids["calendar"], "marketRulesVersionId": ids["rules"],
                  "corporateActionsVersionId": ids["actions"], "fxVersionId": ids["fx"],
                  "benchmark": {"datasetVersionId": ids["benchmark"], "returnColumn": "return"},
                  "cashFlowDatasetVersionId": None, "frequency": "daily", "annualizationFactor": 252, "riskFreeRate": 0}
    rows = {
        "prices": [{"date": day, "instrumentId": "DEMO", "availableAt": day + "T21:00:00Z",
                    "open": "10", "high": "10", "low": "10", "close": "10", "volume": "1000",
                    "currency": "USD", "adjustment": "unadjusted", "halted": False, "limitUp": False, "limitDown": False}
                   for day in dates],
        "calendar": [{"type": "coverage", "year": 2020, "complete": True}]
                    + [{"type": "session", "date": day, "closeAt": day + "T21:00:00Z"} for day in dates],
        "rules": [{"effectiveFrom": dates[0], "effectiveTo": dates[-1], "lotSize": 1, "settlementSessions": 0,
                   "commissionRate": "0", "minimumCommission": "0", "sellTaxRate": "0", "dividendTaxRate": "0", "slippageBps": "0",
                   "feeCurrency": "USD", "allowOddLotLiquidation": False}],
        "universe": [{"instrumentId": "DEMO", "listedAt": "2019-01-01", "delistedAt": None}],
        "actions": [], "fx": [], "benchmark": [{"date": day, "return": "0"} for day in dates]}
    datasets = []
    for index, (name, values) in enumerate(rows.items()):
        raw = json.dumps(values).encode()
        filename = f"dataset-{index}.json"
        (tmp_path / filename).write_bytes(raw)
        datasets.append({"datasetVersionId": ids[name], "contentHash": "a" * 64,
                         "fileSha256": hashlib.sha256(raw).hexdigest(), "path": filename, "rowCount": len(values),
                         "dataClasses": ["public"], "permittedUses": ["research"], "coverage": {"status": "complete"},
                         "adjustment": "unadjusted" if name == "prices" else "unknown",
                         "schema": {"universeCoverage": "historical"} if name == "universe" else {}})
    code = b"# Squabble fixed template fixed-shares-v1 version 1\n"
    (tmp_path / "code.py").write_bytes(code)
    manifest = {"version": 1, "kind": "backtest", "templateId": "fixed-shares-v1", "templateVersion": "1",
                "codeHash": hashlib.sha256(code).hexdigest(), "codePath": "code.py", "seed": 7,
                "parameters": parameters, "datasets": datasets, "effectiveDataClasses": ["public"], "permittedUses": ["research"],
                "dependencies": {"worker": "1.0.0", "python": platform.python_version(),
                                 **{name: importlib.metadata.version(name) for name in ["quantstats", "pandas", "numpy", "matplotlib", "backtrader"]}},
                "limits": {"maxOutputBytes": 1000000}}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    run(str(path))
    result = json.loads((tmp_path / "outputs" / "result.json").read_text())
    assert result["trades"][0]["date"] == dates[1]
    assert result["finalQuantity"] == 1
    assert result["finalCash"] == 90
    assert (tmp_path / "outputs" / "nav.csv").exists()


def test_provider_shaped_daily_history_runs_through_price_template_without_invented_currency(tmp_path):
    rows = [{"trade_date": "20200106", "close": "121", "_provenance": {"currency": None, "unit": None}},
            {"trade_date": "20200102", "close": "100", "_provenance": {"currency": None, "unit": None}},
            {"trade_date": "20200103", "close": "110", "_provenance": {"currency": None, "unit": None}}]
    raw, code = json.dumps(rows).encode(), b"# Squabble fixed template prices-to-returns-v1 version 1\n"
    (tmp_path / "dataset-0.json").write_bytes(raw)
    (tmp_path / "code.py").write_bytes(code)
    manifest = {"version": 1, "kind": "statistics", "templateId": "prices-to-returns-v1", "templateVersion": "1",
                "codeHash": hashlib.sha256(code).hexdigest(), "codePath": "code.py", "seed": 7,
                "parameters": {"inputKind": "prices", "dateColumn": "trade_date", "priceColumn": "close",
                               "returnBasis": "unadjusted-price-only", "calendarDatasetVersionId": None,
                               "frequency": "daily", "annualizationFactor": 252, "riskFreeRate": 0},
                "datasets": [{"datasetVersionId": str(uuid4()), "contentHash": "a" * 64, "fileSha256": hashlib.sha256(raw).hexdigest(),
                              "path": "dataset-0.json", "rowCount": 3, "dataClasses": ["public"], "permittedUses": ["research"],
                              "adjustment": "unadjusted", "coverage": {"status": "complete"}}],
                "effectiveDataClasses": ["public"], "permittedUses": ["research"],
                "dependencies": {"worker": "1.0.0", "python": platform.python_version(),
                                 **{name: importlib.metadata.version(name) for name in ["quantstats", "pandas", "numpy", "matplotlib", "backtrader"]}},
                "limits": {"maxOutputBytes": 1000000}}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    run(str(path))
    result = json.loads((tmp_path / "outputs" / "result.json").read_text())
    assert result["totalReturn"] == pytest.approx(0.21)
    assert result["templateId"] == "prices-to-returns-v1"
    assert result["annualizedReturn"] is None
    assert result["priceEvidence"]["currency"] is None
    assert "PRICE_ONLY_EXCLUDES_DIVIDENDS_AND_SPLIT_ADJUSTMENT" in result["priceEvidence"]["limitations"]
    csv = (tmp_path / "outputs" / "returns.csv").read_text()
    assert "2020-01-03" in csv
    assert "121" not in csv
