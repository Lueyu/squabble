"""Generate self-authored CC0 document fixtures; never claim these are engine results."""
import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from pypdf import PdfReader, PdfWriter


def digital_pdf(pages):
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text, rotation in pages:
        page_id = len(objects) + 1
        stream_id = page_id + 1
        kids.append(f"{page_id} 0 R")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate {rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>".encode())
        commands = [b"BT /F1 14 Tf 40 750 Td"]
        for line in text.splitlines():
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            commands.append(f"({escaped}) Tj 0 -25 Td".encode("ascii"))
        stream = b"\n".join(commands) + b"\nET"
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Count {len(kids)} /Kids [{' '.join(kids)}] >>".encode()
    result = bytearray(b"%PDF-1.7\n")
    offsets = [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{index} 0 obj\n".encode() + value + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--font", required=True, help="Local CJK TrueType/OpenType font; font is not redistributed")
    parser.add_argument("--output", default=str(Path(__file__).parent / "fixtures"))
    args = parser.parse_args()
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(args.font, 42)
    gold = []

    def save(name, data, kind, expected, flags=None, state="parsed"):
        (root / name).write_bytes(data)
        gold.append({"file": name, "sha256": hashlib.sha256(data).hexdigest(), "kind": kind,
                     "expectedText": expected, "flags": flags or [], "expectedState": state,
                     "engineMeasured": False, "license": "CC0-1.0"})

    digital = [
        ("01-english.pdf", "Fictional annual report 2025\nRevenue USD 1200\nTotal 1200", ["1200", "2025"], []),
        ("02-minus.pdf", "Loss -120.50\nYear 2024", ["-120.50", "2024"], ["negative"]),
        ("03-parentheses.pdf", "Operating loss (120.50)\nUSD millions", ["(120.50)", "millions"], ["parenthesized_negative"]),
        ("04-zero.pdf", "Cash flow 0\nTotal 0", ["0"], ["zero_is_known"]),
        ("05-decimals.pdf", "Shares 10000000000000001.23\nEPS 0.00001", ["10000000000000001.23", "0.00001"], ["precision"]),
        ("06-rotated.pdf", "Rotated page\nRevenue 250", ["250"], ["rotation_90"]),
        ("07-year.pdf", "2023 Revenue 100\n2024 Revenue 90\n2025 Revenue 110", ["2023", "2024", "2025", "100", "90", "110"], ["year_columns"]),
        ("08-total.pdf", "Segment A 10\nSegment B 20\nTotal 30", ["10", "20", "30"], ["total_verified_by_gold"]),
        ("09-bad-total.pdf", "Segment A 10\nSegment B 20\nTotal 35", ["10", "20", "35"], ["total_discrepancy_preserve_original"]),
        ("10-printed-label.pdf", "Printed page iii\nRevenue 40", ["iii", "40"], ["physical_page_1_printed_iii"]),
    ]
    for name, text, expected, flags in digital:
        save(name, digital_pdf([(text, 90 if "rotation_90" in flags else 0)]), "digital_pdf", expected, flags)
    save("11-cross-page.pdf", digital_pdf([("Revenue table 2025\nUnit USD million\nSegment A 10", 0),
        ("Revenue table continued\nSegment B 20\nTotal 30", 0)]), "digital_pdf", ["2025", "10", "20", "30"], ["cross_page_table", "2_physical_pages"])

    for name, text, expected, flags in [
        ("12-chinese-scan.pdf", "自制财务样本\n2025年营业收入 120 万元\n净利润（20）万元", ["2025", "120", "20", "万元"], ["chinese_ocr", "unit"]),
        ("13-scan-minus.pdf", "经营现金流 −125.50 万元\n2024 年", ["125.50", "万元", "2024"], ["unicode_minus", "chinese_ocr"]),
        ("14-scan-rotated.pdf", "旋转扫描样本\n收入 300 万元", ["300", "万元"], ["rotated_scan", "chinese_ocr"]),
    ]:
        image = Image.new("RGB", (1200, 1600), "white")
        ImageDraw.Draw(image).multiline_text((70, 90), text, font=font, fill="black", spacing=30)
        if "rotated_scan" in flags:
            image = image.rotate(90, expand=True)
        output = io.BytesIO()
        image.save(output, format="PDF", resolution=144.0)
        save(name, output.getvalue(), "scanned_pdf", expected, flags)

    for name, content, table in [("15-paragraph.docx", "自制段落样本 2025 年 收入 600 万元", False),
                                  ("16-table.docx", "Fictional table with stable cells", True),
                                  ("17-signs.docx", "Loss (75.25) USD million; cash -12.50", False)]:
        document = Document()
        document.add_paragraph(content)
        if table:
            rows = document.add_table(rows=3, cols=2)
            for cells, values in zip(rows.rows, [("Year", "Revenue"), ("2024", "100"), ("2025", "120")]):
                for cell, value in zip(cells.cells, values):
                    cell.text = value
        output = io.BytesIO()
        document.save(output)
        save(name, output.getvalue(), "docx", [content], ["element_ids_no_physical_pages"])

    writer = PdfWriter()
    writer.append(PdfReader(io.BytesIO(digital_pdf([("Private encrypted fixture 42", 0)]))))
    writer.encrypt("fixture-only-password")
    encrypted = io.BytesIO()
    writer.write(encrypted)
    save("18-encrypted.pdf", encrypted.getvalue(), "pdf", [], ["encrypted"], "rejected_or_password_required")
    save("19-corrupt.pdf", b"%PDF-1.7\nthis is intentionally not a valid PDF", "pdf", [], ["corrupt"], "rejected")
    save("20-oversized.pdf", b"%PDF-1.7\n" + b"0" * (8 * 1024 * 1024), "pdf", [], ["over_8_mib"], "rejected_before_upload")
    (root / "gold.json").write_text(json.dumps({"version": 1, "synthetic": True, "engineAcceptance": "not_run",
        "fontSha256": hashlib.sha256(Path(args.font).read_bytes()).hexdigest(), "cases": gold}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"cases": len(gold), "output": str(root), "engineAcceptance": "not_run"}))


if __name__ == "__main__":
    main()
