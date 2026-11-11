import math
import pytest

from squabble_analytics.statistics import summarize_returns


def test_known_statistics_use_explicit_periods_and_period_win_rate():
    values = [0.1, -0.1, 0.0, 0.05]
    actual = summarize_returns(values, periods_per_year=4, risk_free_rate=0.0,
                               frequency="quarterly", benchmark=[0.0] * 4)
    assert actual["observations"] == 4
    assert actual["positivePeriodRatio"] == 0.5
    assert actual["totalReturn"] == pytest.approx(1.1 * 0.9 * 1.05 - 1)
    assert actual["maxDrawdown"] == pytest.approx(-0.1)
    assert actual["annualizedVolatility"] > 0
    assert actual["annualizationFactor"] == 4
    assert actual["benchmarkTotalReturn"] == 0


def test_missing_returns_are_preserved_and_never_counted_as_zero():
    actual = summarize_returns([0.1, None, -0.1], periods_per_year=252,
                               risk_free_rate=0.0, frequency="daily", benchmark=None)
    assert actual["observations"] == 2
    assert actual["missingPeriods"] == 1
    assert actual["positivePeriodRatio"] == 0.5
    assert actual["coverage"] == "partial"
    assert actual["benchmarkTotalReturn"] is None
    assert all(value is None or not isinstance(value, float) or math.isfinite(value)
               for value in actual.values())


def test_missing_required_statistics_assumptions_fail():
    with pytest.raises(ValueError, match="ANNUALIZATION"):
        summarize_returns([0.1], periods_per_year=0, risk_free_rate=0,
                          frequency="daily", benchmark=None)
    with pytest.raises(ValueError, match="RETURN_VALUE"):
        summarize_returns([float("nan")], periods_per_year=252, risk_free_rate=0,
                          frequency="daily", benchmark=None)


def test_zero_variance_and_downside_absence_remain_unknown_ratios():
    actual = summarize_returns([0, 0, 0], periods_per_year=252, risk_free_rate=0,
                               frequency="daily", benchmark=None)
    assert actual["sharpe"] is None
    assert actual["sortino"] is None
