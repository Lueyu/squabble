"""Fixed statistics template. Missing observations are never manufactured."""
from math import isfinite
from numbers import Real

import numpy as np
import pandas as pd
import quantstats as qs


def _series(values):
    cleaned = []
    for value in values:
        if value is None:
            cleaned.append(np.nan)
        elif isinstance(value, bool) or not isinstance(value, Real) or not isfinite(value) or value < -1:
            raise ValueError("RETURN_VALUE_INVALID")
        else:
            cleaned.append(float(value))
    return pd.Series(cleaned, index=pd.date_range("2000-01-01", periods=len(cleaned), freq="D"), dtype=float)


def _finite(value):
    return float(value) if value is not None and isfinite(float(value)) else None


def summarize_returns(values, *, periods_per_year, risk_free_rate, frequency, benchmark):
    if not isinstance(periods_per_year, int) or isinstance(periods_per_year, bool) or not 1 <= periods_per_year <= 100000:
        raise ValueError("ANNUALIZATION_REQUIRED")
    if frequency not in {"daily", "weekly", "monthly", "quarterly", "annual", "custom"}:
        raise ValueError("RETURN_FREQUENCY_REQUIRED")
    if not isinstance(risk_free_rate, Real) or not isfinite(risk_free_rate) or risk_free_rate <= -1:
        raise ValueError("RISK_FREE_RATE_REQUIRED")
    series = _series(values)
    observed = series.dropna()
    n = len(observed)
    nav = np.concatenate(([1.0], (1 + observed.to_numpy()).cumprod()))
    drawdown = nav / np.maximum.accumulate(nav) - 1
    benchmark_series = None if benchmark is None else _series(benchmark)
    if benchmark_series is not None and len(benchmark_series) != len(series):
        raise ValueError("BENCHMARK_LENGTH_MISMATCH")
    # QuantStats uses the supplied annualization factor; no implicit daily/252 assumption.
    sharpe = qs.stats.sharpe(observed, rf=risk_free_rate, periods=periods_per_year) if n > 1 and observed.std() > 0 else None
    sortino = qs.stats.sortino(observed, rf=risk_free_rate, periods=periods_per_year) if n > 1 and (observed < 0).any() else None
    total = float(qs.stats.comp(observed)) if n else None
    return {
        "templateId": "returns-v1", "templateVersion": "1", "quantstatsVersion": qs.__version__,
        "frequency": frequency, "annualizationFactor": periods_per_year, "annualRiskFreeRate": risk_free_rate,
        "observations": n, "missingPeriods": int(series.isna().sum()),
        "coverage": "partial" if series.isna().any() or not n else "complete",
        "totalReturn": total,
        "annualizedReturn": _finite((1 + total) ** (periods_per_year / n) - 1) if n else None,
        "annualizedVolatility": _finite(observed.std(ddof=1) * np.sqrt(periods_per_year)) if n > 1 else None,
        "sharpe": _finite(sharpe), "sortino": _finite(sortino),
        "maxDrawdown": _finite(drawdown.min()) if n else None,
        "positivePeriodRatio": float((observed > 0).sum() / n) if n else None,
        "positivePeriodRatioBasis": "positive-return periods / observed return periods; not trade win rate",
        "benchmarkTotalReturn": _finite(qs.stats.comp(benchmark_series.dropna()))
        if benchmark_series is not None and len(benchmark_series.dropna()) else None,
        "benchmarkMissingPeriods": int(benchmark_series.isna().sum()) if benchmark_series is not None else None,
        "missingValuePolicy": "excluded with partial coverage; never filled with zero",
    }
