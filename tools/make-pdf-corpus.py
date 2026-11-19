import argparse
import io
import json
import random
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfgen.canvas import Canvas


DOMAINS = {
    "finance": ("Monthly reconciliation", ["Opening balance", "Accrued interest", "Cash adjustment", "Closing balance"], "$"),
    "healthcare": ("Clinic supply inventory", ["Sterile dressings", "Exam gloves", "Collection tubes", "Saline packs"], "units"),
    "engineering": ("Equipment inspection", ["Input voltage", "Motor current", "Case temperature", "Vibration"], "reading"),
    "education": ("Course assessment", ["Lab practical", "Written assessment", "Project presentation", "Final review"], "points"),
    "logistics": ("Warehouse transfer", ["Pallet count", "Packed cartons", "Returned containers", "Verified freight"], "items"),
    "construction": ("Site progress record", ["Site preparation", "Foundation work", "Interior partitions", "Utility connections"], "%"),
    "agriculture": ("Field survey", ["North plot", "Irrigation zone", "Greenhouse yield", "South plot"], "kg"),
    "energy": ("Meter settlement statement", ["Peak demand", "Off-peak consumption", "Exported energy", "Total consumption"], "kWh"),
    "legal": ("Records review schedule", ["Filed exhibits", "Acknowledgments", "Submitted notices", "Reviewed records"], "items"),
    "environment": ("Water quality report", ["Upstream station", "Treatment outlet", "Retention basin", "Downstream station"], "mg/L"),
}
VARIANTS = (
    "merged-headers", "variable-row-dividers", "two-column-panels", "three-column-panels",
    "partial-rules", "reverse-stream", "landscape", "fillable-widgets",
    "continued-table", "scan-with-margin", "borderless-table", "nested-table",
)
BLUE = HexColor("#13354c")
SHADE = HexColor("#e6eff3")
LINE = HexColor("#587282")


def text(pdf, value, x, baseline, size=9, bold=False):
    pdf.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    pdf.setFillColor(BLUE)
    pdf.drawString(x, baseline, value)


def table(pdf, x, y, width, labels, key, variant, unit, rng, controls):
    cols = [0, width * .46, width * .63, width * .81, width]
    if width < 190:
        cols = [0, width * .54, width * .69, width * .84, width]
    row_height = [21, 20, 32, 34, 32, 33]
    ys = [y]
    for height in row_height:
        ys.append(ys[-1] - height)
    page_rows = [[key, "", "", unit], ["Item", "Plan", "Actual", "Delta"]]
    cells = []
    for r, label in enumerate(labels, 2):
        plan = rng.randint(10, 87)
        actual = plan + rng.randint(-8, 9)
        marker = f"{key}R{r-1}"
        page_rows.append([f"{marker} {label}", str(plan), str(actual), f"{actual-plan:+d}"])
    pdf.setFillColor(SHADE)
    pdf.rect(x, ys[2], width, y - ys[2], fill=1, stroke=0)
    pdf.setStrokeColor(LINE)
    pdf.setLineWidth(.55)
    if variant != "borderless-table":
        for r, boundary in enumerate(ys):
            if variant == "partial-rules" and r == 4:
                pdf.line(x + cols[1], boundary, x + width, boundary)
            else:
                pdf.line(x, boundary, x + width, boundary)
        for c, shift in enumerate(cols):
            if c in (0, 4):
                pdf.line(x + shift, y, x + shift, ys[-1])
            else:
                pdf.line(x + shift, ys[0] if c == 3 else ys[1], x + shift,
                         ys[2] if variant == "partial-rules" else ys[-1])

    for r, row in enumerate(page_rows):
        for c, value in enumerate(row):
            if not value:
                continue
            xx = x + cols[c] + 4
            cell_width = cols[c + 1] - cols[c] - 7
            if r == 0 and c == 0:
                cell_width = cols[3] - 7
            if variant == "partial-rules" and r == 4 and c == 0:
                continue
            if variant == "variable-row-dividers" and r >= 3 and c == 0:
                value = value.replace(" ", "\n", 1)
            if variant == "partial-rules" and r == 3 and c == 0:
                value += "\n" + page_rows[4][0]
            cells.append((value, xx, ys[r] - 12, cell_width, r < 2))
    if variant == "reverse-stream":
        rng.shuffle(cells)
    for value, xx, baseline, cell_width, bold in cells:
        size = 7 if width < 190 else 9
        for part in value.split("\n"):
            for line in simpleSplit(part, "Helvetica-Bold" if bold else "Helvetica", size, cell_width):
                text(pdf, line, xx, baseline, size, bold)
                baseline -= size + 1
    if variant == "nested-table":
        inner_x = x + cols[1] + 4
        inner_y = ys[3] - 5
        inner_w = max(42, cols[2] - cols[1] - 10)
        pdf.setStrokeColor(LINE)
        pdf.setLineWidth(.4)
        pdf.rect(inner_x, inner_y - 22, inner_w, 22, fill=0, stroke=1)
        pdf.line(inner_x + inner_w * .5, inner_y, inner_x + inner_w * .5, inner_y - 22)
        pdf.line(inner_x, inner_y - 11, inner_x + inner_w, inner_y - 11)
        text(pdf, "Sub", inner_x + 3, inner_y - 8, 5, True)
        text(pdf, "Value", inner_x + inner_w * .5 + 3, inner_y - 8, 5, True)
        text(pdf, "A", inner_x + 3, inner_y - 19, 5)
        text(pdf, "1", inner_x + inner_w * .5 + 3, inner_y - 19, 5)
    spans = [{"r": 0, "c": 0, "rowspan": 1, "colspan": 3}]
    if variant == "partial-rules":
        page_rows[3][0] += " " + page_rows[4][0]
        page_rows[4][0] = ""
        spans.append({"r": 3, "c": 0, "rowspan": 2, "colspan": 1})
    if variant == "fillable-widgets":
        label = f"{key} verified"
        name = f"{key}_verified"
        text(pdf, label, x + 16, ys[-1] - 21, 8)
        pdf.acroForm.checkbox(name=name, tooltip=label, x=x, y=ys[-1] - 24, size=10,
                              checked=True, buttonStyle="check", borderColor=LINE, fillColor=white)
        controls.append({"name": name, "type": "checkbox", "checked": True, "label": label})
        label = f"{key} reference"
        name = f"{key}_reference"
        value = f"Ref-{rng.randint(1000, 9999)}"
        text(pdf, label, x, ys[-1] - 42, 8)
        pdf.acroForm.textfield(name=name, tooltip=label, x=x + 106, y=ys[-1] - 47,
                               width=78, height=15, value=value, borderColor=LINE, fillColor=white)
        controls.append({"name": name, "type": "text", "value": value, "label": label})
    return {"rows": page_rows, "spans": spans, "anchor": key}


def draw_chart(pdf, x, y, width, key, rng):
    text(pdf, f"{key} Weekly totals", x, y + 94, 10, True)
    pdf.setStrokeColor(LINE)
    pdf.line(x, y, x + width, y)
    for i, label in enumerate(("Mon", "Tue", "Wed", "Thu")):
        value = rng.randint(12, 68)
        left = x + 14 + i * width / 4
        pdf.setFillColor(HexColor("#297785"))
        pdf.rect(left, y, width / 8, value, fill=1, stroke=0)
        text(pdf, str(value), left, y + value + 4, 8)
        text(pdf, label, left, y - 12, 8)


def raster_pdf(source, target, variant):
    with tempfile.TemporaryDirectory(prefix="ingestlab-scan-") as tmp:
        output = Path(tmp) / "page"
        completed = subprocess.run(
            ["pdftoppm", "-q", "-singlefile", "-r", "156", "-png", str(source), str(output)],
            capture_output=True,
        )
        if completed.returncode:
            raise RuntimeError(completed.stderr.decode(errors="replace")[-1500:])
        with Image.open(output.with_suffix(".png")) as image:
            scan = image.convert("RGB")
        if variant % 2:
            scan = scan.rotate(.34, fillcolor="white", resample=Image.Resampling.BICUBIC)
        stamp = Image.new("RGB", (900, 28), "white")
        drawing = ImageDraw.Draw(stamp)
        for x in range(0, 900, 150):
            drawing.text((x, 4), "ARCHIVE QA", fill="#242424")
        stamp = stamp.rotate(90, expand=True)
        scan.paste(stamp, (scan.width - 31, 140))
        pdf = Canvas(str(target), pagesize=(612, 792), invariant=1)
        pdf.drawImage(ImageReader(scan), 0, 0, width=612, height=792)
        pdf.save()


def make_document(folder, domain, spec, variant, index):
    rng = random.Random(domain + variant)
    title, labels, unit = spec
    target = folder / f"{domain}-{variant}.pdf"
    source = io.BytesIO()
    page_size = (792, 612) if variant == "landscape" else (612, 792)
    pdf = Canvas(source, pagesize=page_size, invariant=1)
    pdf.setTitle(title)
    width, height = page_size
    page_count = 2 if variant == "continued-table" else 1
    expected = {"file": target.name, "domain": domain, "variant": variant, "pages": []}
    for page in range(page_count):
        text(pdf, title, 44, height - 54, 20, True)
        text(pdf, f"Reference {index:03d}    Operations review    Page {page+1} of {page_count}", 44, height - 75)
        panels = 3 if variant == "three-column-panels" else 2 if variant in ("two-column-panels", "landscape") else 1
        gap = 12 if panels == 3 else 22
        panel_width = (width - 88 - gap * (panels - 1)) / panels
        page_data = {"tables": [], "controls": [], "order": []}
        for panel in range(panels):
            xx = 44 + panel * (panel_width + gap)
            if panels > 1:
                text(pdf, f"Panel {chr(65 + panel)} - " + ("Planning", "Execution", "Review")[panel],
                     xx, height - 107, 10, True)
            key = f"T{index:03d}{page+1}{chr(65+panel)}"
            count = 1 if variant == "fillable-widgets" else 2
            for section in range(count):
                anchor = key if section == 0 else key + "X"
                top = height - 126 - section * 210
                if panels == 3 and panel == 1:
                    top -= 18
                result = table(pdf, xx, top, panel_width,
                               labels[section:] + labels[:section], anchor, variant, unit, rng, page_data["controls"])
                result["bbox"] = {"x0": xx, "x1": xx + panel_width, "y0": height - top, "y1": height - top + 172}
                page_data["tables"].append(result)
                page_data["order"].append(anchor)
        if variant in ("merged-headers", "reverse-stream", "fillable-widgets"):
            draw_chart(pdf, 46, 105, width - 94, f"Chart {index:03d}", rng)
        text(pdf, "Reviewed by Planning and Operations", 44, 38, 8)
        expected["pages"].append(page_data)
        pdf.showPage()
    pdf.save()
    if variant == "scan-with-margin":
        with tempfile.TemporaryDirectory(prefix="ingestlab-source-") as tmp:
            path = Path(tmp) / "vector.pdf"
            path.write_bytes(source.getbuffer())
            raster_pdf(path, target, index)
    else:
        target.write_bytes(source.getbuffer())
    return expected


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("folder", type=Path, nargs="?", default=Path("../pdf/corpus-150/synthetic"))
    args = cli.parse_args()
    args.folder.mkdir(parents=True, exist_ok=True)
    manifest = []
    for domain, spec in DOMAINS.items():
        for variant in VARIANTS:
            manifest.append(make_document(args.folder, domain, spec, variant, len(manifest) + 1))
    (args.folder / "ground-truth.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(manifest)} PDFs and ground-truth.json to {args.folder}")


if __name__ == "__main__":
    main()
