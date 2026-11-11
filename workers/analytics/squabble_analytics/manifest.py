"""Validate server-generated full-input manifests before calculation."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re


def validate_manifest(value):
    if value.get("version") != 1 or value.get("kind") not in {"statistics", "backtest", "exploratory"}:
        raise ValueError("MANIFEST_INVALID")
    if value["kind"] == "exploratory" and value.get("parameters", {}).get("validated"):
        raise ValueError("EXPLORATORY_NOT_VALIDATED")
    if not isinstance(value.get("seed"), int) or not re.fullmatch("[a-f0-9]{64}", value.get("codeHash", "")):
        raise ValueError("MANIFEST_PROVENANCE_REQUIRED")
    if not value.get("templateId") or not value.get("templateVersion") or not value.get("dependencies"):
        raise ValueError("MANIFEST_PROVENANCE_REQUIRED")
    datasets = value.get("datasets")
    if not isinstance(datasets, list) or not 1 <= len(datasets) <= 20:
        raise ValueError("DATASETS_REQUIRED")
    classes = set()
    uses = None
    ids = set()
    for dataset in datasets:
        path = PurePosixPath(dataset.get("path", ""))
        if path.is_absolute() or ".." in path.parts or len(path.parts) != 1 or not re.fullmatch(r"dataset-[0-9]+\.json", str(path)):
            raise ValueError("INPUT_PATH_INVALID")
        if dataset.get("datasetVersionId") in ids:
            raise ValueError("DUPLICATE_DATASET")
        ids.add(dataset.get("datasetVersionId"))
        if not all(re.fullmatch("[a-f0-9]{64}", dataset.get(key, "")) for key in ["contentHash", "fileSha256"]):
            raise ValueError("INPUT_HASH_INVALID")
        if not isinstance(dataset.get("rowCount"), int) or not 0 <= dataset["rowCount"] <= 100000:
            raise ValueError("INPUT_ROWS_INVALID")
        classes.update(dataset.get("dataClasses", []))
        permitted = set(dataset.get("permittedUses", []))
        uses = permitted if uses is None else uses & permitted
    if not classes <= set(value.get("effectiveDataClasses", [])):
        raise ValueError("CLASSIFICATION_DOWNGRADE")
    if not set(value.get("permittedUses", [])) <= uses:
        raise ValueError("PERMITTED_USES_ESCALATION")
    return value


def load_inputs(manifest, root):
    validate_manifest(manifest)
    result = []
    root = Path(root).resolve()
    for dataset in manifest["datasets"]:
        path = (root / dataset["path"]).resolve()
        if path.parent != root or path.is_symlink():
            raise ValueError("INPUT_PATH_INVALID")
        raw = path.read_bytes()
        if len(raw) > 32 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != dataset["fileSha256"]:
            raise ValueError("INPUT_HASH_MISMATCH")
        rows = json.loads(raw)
        if not isinstance(rows, list) or len(rows) != dataset["rowCount"] or any(not isinstance(row, dict) for row in rows):
            raise ValueError("INPUT_ROW_COUNT_MISMATCH")
        result.append(rows)
    return result
