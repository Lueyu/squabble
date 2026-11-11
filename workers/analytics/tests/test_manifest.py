import hashlib
import json
import pytest

from squabble_analytics.manifest import load_inputs, validate_manifest


def manifest_for(data):
    return {"version": 1, "kind": "statistics", "templateId": "returns-v1", "templateVersion": "1",
            "codeHash": "a" * 64, "seed": 7, "parameters": {},
            "datasets": [{"datasetVersionId": "dataset", "contentHash": "b" * 64,
                          "fileSha256": hashlib.sha256(data).hexdigest(), "path": "dataset-0.json",
                          "rowCount": 2, "dataClasses": ["portfolio"], "permittedUses": ["research", "e2b"]}],
            "effectiveDataClasses": ["portfolio"], "permittedUses": ["research", "e2b"],
            "dependencies": {"worker": "1.0.0"}, "limits": {"maxOutputBytes": 1000000}}


def test_manifest_loads_full_exact_input_and_checks_hash(tmp_path):
    data = json.dumps([{"return": "0.1"}, {"return": None}]).encode()
    (tmp_path / "dataset-0.json").write_bytes(data)
    assert len(load_inputs(validate_manifest(manifest_for(data)), tmp_path)[0]) == 2
    (tmp_path / "dataset-0.json").write_bytes(b"[]")
    with pytest.raises(ValueError, match="INPUT_HASH"):
        load_inputs(manifest_for(data), tmp_path)


def test_manifest_rejects_paths_escaping_job_and_classification_downgrades(tmp_path):
    value = manifest_for(b"[]")
    value["datasets"][0]["path"] = "../secret"
    with pytest.raises(ValueError, match="INPUT_PATH"):
        validate_manifest(value)
    value = manifest_for(b"[]")
    value["effectiveDataClasses"] = ["public"]
    with pytest.raises(ValueError, match="CLASSIFICATION"):
        validate_manifest(value)


def test_free_code_can_never_claim_validated_backtest():
    value = manifest_for(b"[]")
    value["kind"] = "exploratory"
    value["parameters"] = {"validated": True}
    with pytest.raises(ValueError, match="EXPLORATORY"):
        validate_manifest(value)
