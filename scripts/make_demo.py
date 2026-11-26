"""Write the demo files every chat can use: web/demo/sales.csv and web/demo/sales.xlsx.

The same 2,000 made-up sales in both, generated from a fixed seed, so the files never change and their totals
are known (the browser tests check them). Standard library only: an .xlsx file is a zip of a few XML parts.
Prices are whole numbers, so every total is exact in CSV, in Excel and in floating point.

    python scripts/make_demo.py
"""

from __future__ import annotations

import csv
import io
import zipfile
from datetime import date, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parent.parent / "web" / "demo"
ROWS = 2000
REGIONS = ["North", "South", "East", "West"]
PRODUCTS = {"Notebook": 12, "Backpack": 25, "Desk lamp": 40, "Headphones": 75, "Office chair": 120}
COLUMNS = ["date", "region", "product", "units", "unit_price", "amount"]


def rows() -> list[list[str | int]]:
    state = 2025
    def next_int(n: int) -> int:
        nonlocal state
        state = (1103515245 * state + 12345) % 2**31
        return (state >> 8) % n
    names = list(PRODUCTS)
    out: list[list[str | int]] = []
    for _ in range(ROWS):
        day = date(2025, 1, 1) + timedelta(days=next_int(365))
        product = names[next_int(len(names))]
        units = 1 + next_int(40)
        out.append([day.isoformat(), REGIONS[next_int(len(REGIONS))], product, units, PRODUCTS[product],
                    units * PRODUCTS[product]])
    return sorted(out, key=lambda row: (row[0], row[1], row[2]))


def write_csv(data: list[list[str | int]]) -> bytes:
    text = io.StringIO()
    writer = csv.writer(text, lineterminator="\n")
    writer.writerow(COLUMNS)
    writer.writerows(data)
    return text.getvalue().encode()


def write_xlsx(data: list[list[str | int]]) -> bytes:
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    pkg = "http://schemas.openxmlformats.org/package/2006/relationships"
    strings: dict[str, int] = {}
    def cell(ref: str, value: str | int) -> str:
        if isinstance(value, int):
            return f'<c r="{ref}"><v>{value}</v></c>'
        index = strings.setdefault(value, len(strings))
        return f'<c r="{ref}" t="s"><v>{index}</v></c>'
    sheet_rows = []
    for number, values in enumerate([COLUMNS, *data], start=1):
        cells = "".join(cell(f"{'ABCDEF'[i]}{number}", v) for i, v in enumerate(values))
        sheet_rows.append(f'<row r="{number}">{cells}</row>')
    shared = "".join(f"<si><t>{escape(s)}</t></si>" for s in strings)
    head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    parts = {
        "[Content_Types].xml": head + (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            "</Types>"),
        "_rels/.rels": head + (
            f'<Relationships xmlns="{pkg}"><Relationship Id="rId1" Type="{rel}/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>'),
        "xl/workbook.xml": head + (
            f'<workbook xmlns="{main}" xmlns:r="{rel}"><sheets>'
            '<sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": head + (
            f'<Relationships xmlns="{pkg}">'
            f'<Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="rId2" Type="{rel}/sharedStrings" Target="sharedStrings.xml"/>'
            "</Relationships>"),
        "xl/worksheets/sheet1.xml": head + f'<worksheet xmlns="{main}"><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>',
        "xl/sharedStrings.xml": head + f'<sst xmlns="{main}" uniqueCount="{len(strings)}">{shared}</sst>',
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2025, 1, 1, 0, 0, 0))  # fixed, so the bytes never change
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, text)
    return out.getvalue()


def main() -> None:
    data = rows()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "sales.csv").write_bytes(write_csv(data))
    (OUT / "sales.xlsx").write_bytes(write_xlsx(data))
    totals: dict[str, int] = {}
    for row in data:
        totals[str(row[1])] = totals.get(str(row[1]), 0) + int(row[5])
    print("rows:", len(data), "total:", sum(totals.values()), "by region:", dict(sorted(totals.items())))


if __name__ == "__main__":
    main()
