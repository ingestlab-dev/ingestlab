"""Build bitmap-only benchmark pages from panel coordinates and authored figures."""

import argparse
import json
import math
from pathlib import Path

import pymupdf as pdf

INK = (0.07, 0.10, 0.17)
BLUE = (0.16, 0.40, 0.79)
ORANGE = (0.86, 0.35, 0.17)


def label(page, x, y, text, size=13):
    page.insert_text((x - pdf.get_text_length(text, fontsize=size) / 2, y), text,
                     fontsize=size, color=INK)


def node(page, x, y, text, fill=(0.78, 0.88, 0.98), w=106, h=34):
    page.draw_rect((x - w/2, y - h/2, x + w/2, y + h/2), color=INK, fill=fill, width=1.4)
    label(page, x, y + 4, text, 12)


def arrow(page, points, color=INK):
    a, b = points[-2:]
    dx, dy = b[0] - a[0], b[1] - a[1]
    norm = math.hypot(dx, dy)
    dx, dy = dx / norm, dy / norm
    x, y = b[0] - dx * 10, b[1] - dy * 10
    page.draw_polyline([*points[:-1], (x, y)], width=1.45, color=color)
    head = page.new_shape()
    head.draw_polyline([b, (x + dy * 4, y - dx * 4), (x - dy * 4, y + dx * 4)])
    head.finish(color=None, fill=color, closePath=True)
    head.commit()


def draw(page, name):
    if name in ("pipeline", "reverse", "grayscale", "two-lines"):
        fill = (0.91, 0.91, 0.91) if name == "grayscale" else (0.78, 0.88, 0.98)
        names = ["Collect", "Review", "Publish"]
        for i, text in enumerate(names):
            node(page, 86 + 150*i, 79, text, fill)
        edges = []
        for i in range(2):
            a, b = (139 + i*150, 79), (183 + i*150, 79)
            if name == "reverse":
                arrow(page, [b, a])
                edges.append([names[i+1], names[i], True])
            elif name == "two-lines" and i == 1:
                page.draw_line(a, b, color=INK, width=1.45)
                edges.append([names[i], names[i+1], False])
            else:
                arrow(page, [a, b])
                edges.append([names[i], names[i+1], True])
        return dict(kind="diagram", nodes=names, edges=edges)
    if name == "decision":
        names = ["Intake", "Eligible", "Approve", "Reject", "Log result"]
        p = [(250, 35), (250, 105), (380, 105), (120, 105), (250, 202)]
        for i, (x, y) in enumerate(p):
            if i == 1:
                shp = page.new_shape()
                shp.draw_polyline([(x, y-27), (x+56, y), (x, y+27), (x-56, y)])
                shp.finish(color=INK, fill=(1, .92, .72), closePath=True)
                shp.commit()
                label(page, x, y+4, names[i])
            else:
                node(page, x, y, names[i])
        for points in [[(250,52),(250,78)],[(306,105),(327,105)],[(194,105),(173,105)],
                       [(120,122),(120,202),(197,202)],[(380,122),(380,202),(303,202)]]:
            arrow(page, points)
        return dict(kind="diagram", nodes=names, edges=[[names[a], names[b], True] for a,b in
                    [(0,1),(1,2),(1,3),(2,4),(3,4)]])
    if name == "feedback":
        names = ["Read queue", "Schedule", "Worker", "Checkpoint", "Retry"]
        for (x, y), n in zip([(90,65),(250,65),(410,65),(410,186),(250,186)], names):
            node(page, x, y, n)
        for p in [[(143,65),(197,65)],[(303,65),(357,65)],[(410,82),(410,169)],
                  [(357,186),(303,186)],[(250,169),(250,82)],[(197,186),(90,186),(90,82)]]:
            arrow(page, p)
        return dict(kind="diagram", nodes=names, edges=[[names[a], names[b], True] for a,b in
                    [(0,1),(1,2),(2,3),(3,4),(4,1),(4,0)]])
    if name == "table":
        headers = ["Region", "Actual", "Target"]
        rows = [["West","34","39"],["East","52","57"],["North","67","71"],["South","81","86"]]
        for y in range(20, 221, 40):
            page.draw_line((35,y),(465,y),color=INK,width=1.2)
        for x in [35,205,335,465]:
            page.draw_line((x,20),(x,220),color=INK,width=1.2)
        for i, row in enumerate([headers,*rows]):
            for x, value in zip([120,270,400], row):
                label(page, x, 44 + i*40, value, 15)
        return dict(kind="table", headers=headers, rows=rows)
    if name in ("bars", "bars-axis", "grouped", "stacked", "dual-axis", "line"):
        rows = [["Harbor","23","38"],["Hill","47","55"],["Lake","63","71"],["Vale","89","95"]]
        btm, left = 205, 58
        for tick in range(0, 101, 25):
            y = btm - tick*1.65
            page.draw_line((left,y),(457,y),color=(0.78,0.83,0.89),width=0.7)
            label(page, 40, y + 4, str(tick), 11)
        page.draw_polyline([(left,35),(left,btm),(457,btm)], color=INK, width=1.1)
        pts = []
        for i, (word, a, b) in enumerate(rows):
            x = 110 + i*96
            y = btm - int(a)*1.65
            label(page,x,227,word,12)
            if name != "line":
                page.draw_rect((x-22,y,x+(0 if name=="grouped" else 22),btm), color=None, fill=BLUE)
            if name == "bars":
                label(page,x,y-4,a,12)
            if name == "grouped":
                page.draw_rect((x+5,btm-int(b)*1.65,x+27,btm),color=None,fill=ORANGE)
                label(page,x-12,y-4,a,11)
                label(page,x+16,btm-int(b)*1.65-4,b,11)
            if name == "stacked":
                page.draw_rect((x-22,btm-int(b)*1.65,x+22,y),color=None,fill=ORANGE)
            pts.append((x, btm - int(b)*1.65))
        if name in ("line", "dual-axis"):
            page.draw_polyline(pts, color=ORANGE, width=2.1)
            for x, y in pts:
                page.draw_circle((x,y),3,color=None,fill=ORANGE)
        if name in ("grouped", "stacked", "dual-axis"):
            page.draw_rect((167,14,181,23),color=None,fill=BLUE)
            label(page,209,23,"Plan",11)
            page.draw_rect((269,14,283,23),color=None,fill=ORANGE)
            label(page,315,23,"Result",11)
        if name == "dual-axis":
            page.draw_line((457,35),(457,btm),color=INK)
            for tick in range(0, 21, 5):
                label(page,476,btm-tick*8.25+4,str(tick),11)
        if name == "line":
            return dict(kind="line-series", headers=["Category","Value"], rows=[[a,c] for a,_,c in rows])
        if name in ("bars", "bars-axis"):
            return dict(kind="bar", headers=["Category","Value"], rows=[[a,b] for a,b,_ in rows])
        if name == "stacked":
            return dict(kind="stacked-bar", headers=["Category","Plan","Result"],
                        rows=[[a,b,str(int(c)-int(b))] for a,b,c in rows])
        return dict(kind="grouped-bar" if name=="grouped" else "combo",
                    headers=["Category","Plan","Result"],
                    rows=rows if name=="grouped" else [[a,b,f"{int(c)/5:g}"] for a,b,c in rows])
    if name in ("pie", "rings"):
        rows = [["Field","52"],["Office","31"],["Transit","17"]]
        if name == "rings":
            rows = [["Readiness","68"],["Reliability","53"],["Coverage","37"]]
            for i, (series, value) in enumerate(rows):
                c, r = (250,133), 85 - i*18
                start = (c[0], c[1] - r)
                angle = int(value)*2.7
                shp = page.new_shape()
                end = shp.draw_sector(c, start, -angle, fullSector=False)
                shp.finish(color=[ORANGE,BLUE,(0.15,0.64,0.43)][i],width=7)
                shp.commit()
                label(page,195,50 + i*18,series,9)
                label(page,end.x - 7,end.y + 3,value,9)
            return dict(kind="radial", headers=["Series","Printed value"],rows=rows)
        start = 0
        for i, (name, val) in enumerate(rows):
            a = math.radians(start)
            p = (155+79*math.cos(a), 120+79*math.sin(a))
            shp = page.new_shape()
            shp.draw_sector((155,120),p,-int(val)*3.6)
            color = [ORANGE,BLUE,(0.15,0.64,0.43)][i]
            shp.finish(color=None,fill=color)
            shp.commit()
            page.draw_rect((300,68+i*32,314,81+i*32),color=None,fill=color)
            label(page,387,80+i*32,name+"  "+val+"%",13)
            start += int(val)*3.6
        return dict(kind="pie", headers=["Category","Value"],rows=rows)
    if name == "labels":
        label(page,250,110,"Calibration card",22)
        label(page,250,147,"Reference 142",16)
        return None
    raise ValueError(name)


def add_page(doc, bitmap, image_size, case_id, scan=False):
    w, h = image_size
    page = doc.new_page(width=max(260,w + 32), height=h + (32 if scan else 52))
    page.insert_image(pdf.Rect(16, 16 if scan else 32, 16+w, (16 if scan else 32)+h), stream=bitmap)
    if not scan:
        page.insert_text((16,19),"Sample "+case_id,fontsize=10)


def source_group(root, suite, samples):
    out = pdf.open()
    cases = []
    with pdf.open(samples[0]["source"]) as src:
        for sample in samples:
            p = src[sample["page"]-1]
            clip = pdf.Rect(sample["box"]) & p.rect
            # Strip printed captions: they describe the answer and are not
            # part of the figure's pixels. Box boundaries come from the vector preflight.
            for block in p.get_text("dict", clip=clip)["blocks"]:
                for line in block.get("lines", []):
                    text = "".join(span["text"] for span in line["spans"])
                    if (text.lstrip().startswith("Figure ") and
                            line["bbox"][1] >= clip.y0 + clip.height * 0.56):
                        clip.y1 = min(clip.y1, line["bbox"][1] - 1)
            assert clip.width > 56 and clip.height > 36, sample
            bitmap = p.get_pixmap(matrix=pdf.Matrix(3,3),clip=clip,alpha=False)
            add_page(out, bitmap.tobytes("png"), (clip.width,clip.height), sample["id"])
            record = {**sample, "box": list(clip), "referenceText": p.get_text(clip=clip)}
            record.pop("source")
            if sample["id"] == "S1-1":
                labels = ["Input PDF","Vector Ops","AST Builder","Markdown"]
                record["expected"] = dict(kind="diagram",nodes=labels,
                                          edges=[[a,b,True] for a,b in zip(labels,labels[1:])])
            elif sample["id"] == "S1-2":
                record["expected"] = dict(kind="bar",headers=["Category","Value"],
                                          rows=[["v1.0","35"],["v1.1","52"],["v1.2","74"],["v1.3","91"]])
            elif sample["id"] == "S1-3":
                record["expected"] = dict(kind="pie",headers=["Category","Value"],rows=[
                    ["Prose Paragraphs","45"],["Structured Tables","25"],
                    ["Vector Diagrams","20"],["Math Formulas","10"]])
            elif sample["id"] == "S1-82":
                nodes = ["Records Identified (n = 2,400)", "Titles Screened (n = 1,850)",
                         "Full-Text Assessed (n = 210)", "Studies Included in Synthesis (n = 48)",
                         "Excluded by Abstract (n = 1,640)", "Excluded: No Control Arm (n = 162)"]
                record["expected"] = dict(kind="diagram", nodes=nodes,
                    edges=[[nodes[a], nodes[b], True] for a,b in [(0,1),(1,2),(2,3),(1,4),(2,5)]])
            cases.append(record)
    name = f"suite-{suite}-embedded.pdf"
    out.save(root/name, deflate=True)
    out.close()
    return dict(file=name,cases=cases)


def synthetic_group(root, scan=False):
    names = ["labels","pipeline","reverse","grayscale","bars","bars-axis","table","two-lines",
             "pie","rings","grouped","stacked","line","dual-axis","decision","feedback"]
    if scan:
        names = ["pipeline","table","bars","decision"]
    out, cases = pdf.open(), []
    for i, name in enumerate(names,1):
        case_id = ("SCAN" if scan else "GEN") + "-" + str(i)
        with pdf.open() as source:
            page = source.new_page(width=500,height=245)
            expected = draw(page,name)
            reference = page.get_text()
            low_res = name in ("grayscale", "decision", "feedback") or scan
            scale = 1.6 if low_res else 3
            pix = page.get_pixmap(matrix=pdf.Matrix(scale,scale),
                                  colorspace=pdf.csGRAY if name=="grayscale" or scan else pdf.csRGB)
            add_page(out,pix.tobytes("jpeg",jpg_quality=58) if low_res else pix.tobytes("png"),
                     (page.rect.width,page.rect.height),case_id,scan)
            cases.append(dict(id=case_id,caption=name,referenceText=reference,expected=expected))
    file = "synthetic-scan.pdf" if scan else "synthetic-embedded.pdf"
    out.save(root/file,deflate=True)
    out.close()
    return dict(file=file,cases=cases,scan=scan)


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("output", type=Path)
    args = cli.parse_args()
    root = args.output
    panels = json.loads((root/"panels.json").read_text(encoding="utf-8"))
    groups = [source_group(root,n,[p for p in panels if p["suite"]==n]) for n in [1,2]]
    groups.extend(synthetic_group(root,scan=scan) for scan in [False,True])
    (root/"cases.json").write_text(json.dumps(groups,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
