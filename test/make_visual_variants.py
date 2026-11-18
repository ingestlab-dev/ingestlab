"""Generate independently authored vector PDFs for the visual regression tests."""

from pathlib import Path
import sys

from reportlab.lib.colors import HexColor
from reportlab.pdfgen import canvas


def make(path, scale, labels, numbers, printed):
    c = canvas.Canvas(str(path), pagesize=(612, 792), invariant=True)
    c.translate(65 if scale == 1 else 144, 380)
    c.scale(scale, scale)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(15, 270, "Weekly capacity")
    c.setFont("Helvetica", 10)
    c.setStrokeColor(HexColor("#303841"))
    c.line(80, 90, 430, 90)
    c.line(80, 90, 80, 240)
    for y in range(5):
        c.drawRightString(74, 87 + y * 35, str(y * 25))
    for i, (label, n) in enumerate(zip(labels, numbers)):
        x = 125 + 75 * i
        c.setFillColor(HexColor("#246a8a"))
        c.rect(x - 16, 90, 32, n * 1.4, stroke=0, fill=1)
        c.setFillColor(HexColor("#111111"))
        c.drawCentredString(x, 74, label)
        if printed:
            c.drawCentredString(x, 96 + n * 1.4, str(n))
    c.showPage()

    c.translate(73 if scale == 1 else 145, 478)
    c.scale(scale, scale)
    c.setFont("Helvetica", 11)
    nodes = ["Receive", "Validate", "Archive"] if printed else ["Collect", "Review", "Publish"]
    for i, name in enumerate(nodes):
        x = 130 * i
        c.setFillColor(HexColor("#e2eef2"))
        c.setStrokeColor(HexColor("#294455"))
        c.roundRect(x, 0, 90, 34, 5, fill=1, stroke=1)
        c.setFillColor(HexColor("#111111"))
        c.drawCentredString(x + 45, 13, name)
        if i < 2:
            c.line(x + 90, 17, x + 122, 17)
            p = c.beginPath()
            p.moveTo(x + 130, 17)
            p.lineTo(x + 122, 13)
            p.lineTo(x + 122, 21)
            p.close()
            c.drawPath(p, stroke=0, fill=1)
    c.save()


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    make(out / "visual-printed.pdf", 1, ["North", "South", "West"], [37, 63, 82], True)
    make(out / "visual-estimated.pdf", 0.8, ["Alpha", "Beta", "Gamma", "Delta"], [24, 51, 76, 89], False)
