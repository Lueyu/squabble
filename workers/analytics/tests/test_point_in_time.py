import pytest
from squabble_analytics.point_in_time import visible_rows, validate_inputs


def test_announcement_period_is_not_information_availability():
    records = [{"reportPeriod": "2019-12-31", "availableAt": "2020-03-20T12:00:00Z", "value": 100}]
    assert visible_rows(records, "2020-03-19T21:00:00Z") == []
    assert visible_rows(records, "2020-03-20T21:00:00Z") == records


def test_revision_does_not_replace_original_historical_information():
    rows = [{"key": "earnings", "availableAt": "2020-01-02T12:00:00Z", "value": 1},
            {"key": "earnings", "availableAt": "2021-01-02T12:00:00Z", "value": 99}]
    assert visible_rows(rows, "2020-05-01T00:00:00Z")[0]["value"] == 1
    assert len(visible_rows(rows, "2020-05-01T00:00:00Z")) == 1


def test_missing_availability_cannot_claim_validated():
    with pytest.raises(ValueError, match="AVAILABLE_AT"):
        visible_rows([{"reportPeriod": "2019-12-31"}], "2020-01-01T00:00:00Z")
