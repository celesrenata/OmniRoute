#!/usr/bin/env python3
"""Directive 39.2: assemble pulse contact strips from pw-atomic-pulse-strip.mjs frames.
   python3 scripts/ad-hoc/pulse-strip.py <framesDir> <tag> <x0,y0,x1,y1> <out.jpg>
Each row is one frame (real capture time from strip-report.json) cropped to the same board
region at full device resolution, so a pulse's displacement between rows is its travel."""
import json, sys
from PIL import Image, ImageDraw, ImageFont
d, tag, box, out = sys.argv[1], sys.argv[2], tuple(int(v) for v in sys.argv[3].split(",")), sys.argv[4]
rep = json.load(open(f"{d}/strip-report.json"))
picked = rep["default" if tag == "default" else "closeup"]["picked"]
crops = [Image.open(f"{d}/{p['file']}").convert("RGB").crop(box) for p in picked]
w, h = crops[0].size
cols = 2
rows = (len(crops) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w + (cols - 1) * 8, rows * h + (rows - 1) * 8), (20, 20, 24))
dr = ImageDraw.Draw(sheet)
font = ImageFont.load_default(size=40)
for i, (c, p) in enumerate(zip(crops, picked)):
    x, y = (i % cols) * (w + 8), (i // cols) * (h + 8)
    sheet.paste(c, (x, y))
    dr.rectangle([x, y, x + 360, y + 60], fill=(0, 0, 0))
    dr.text((x + 8, y + 8), f"#{i}  t={p['tMs']} ms", fill=(255, 255, 255), font=font)
sheet.save(out, quality=90)
print(out, sheet.size)
