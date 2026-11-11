"""Verify synthetic input/gold integrity and native structures; does not run OCR."""
import hashlib
import io
import json
from pathlib import Path

from docx import Document
from pypdf import PdfReader

root = Path(__file__).parent / "fixtures"
gold = json.loads((root / "gold.json").read_text(encoding="utf-8"))
assert gold["engineAcceptance"] == "not_run"
assert len(gold["cases"]) == 20
for case in gold["cases"]:
    data = (root / case["file"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == case["sha256"], case["file"]
    if case["kind"] == "digital_pdf":
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() for page in reader.pages)
        assert all(value in text for value in case["expectedText"]), case["file"]
        if "2_physical_pages" in case["flags"]:
            assert len(reader.pages) == 2
        if "rotation_90" in case["flags"]:
            assert reader.pages[0].rotation == 90
    elif case["kind"] == "scanned_pdf":
        reader = PdfReader(io.BytesIO(data))
        assert len(reader.pages) == 1
        assert not reader.pages[0].extract_text().strip()
    elif case["kind"] == "docx":
        document = Document(io.BytesIO(data))
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        assert all(value in text for value in case["expectedText"])
    elif "encrypted" in case["flags"]:
        assert PdfReader(io.BytesIO(data)).is_encrypted
    elif "over_8_mib" in case["flags"]:
        assert len(data) > 8 * 1024 * 1024
print(json.dumps({"cases": 20, "nativeStructureAndHashChecks": "passed", "engineAcceptance": "not_run"}))
