#!/usr/bin/env python3
"""Compose idea5 side-by-sides (full PNG) and 1800px JPEG previews for Gate A captures."""
import glob, os, sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
d = sys.argv[1]
ref = Image.open(sys.argv[2]).convert("RGB")
pairs = {"default-3c": "gateA-provider-default-3c", "close-3c": "gateA-provider-close-3c",
         "hub-close": "gateA-hub-close", "hub-default": "gateA-hub-default",
         "idle-vs-excited": "gateA-idle-vs-excited", "az90": "gateA-3c-az90",
         "unknown-close": "gateA-provider-close-unknown", "webgl2": "gateA-webgl2-fallback"}
os.makedirs(f"{d}/preview", exist_ok=True)
for k, src in pairs.items():
    im = Image.open(f"{d}/{src}.png").convert("RGB")
    h = im.height
    r = ref.resize((int(ref.width * h / ref.height), h))
    out = Image.new("RGB", (r.width + im.width, h)); out.paste(r, (0, 0)); out.paste(im, (r.width, 0))
    out.save(f"{d}/sidebyside-idea5-{k}.png")
for p in glob.glob(f"{d}/*.png") + glob.glob(f"{d}/live/*.png"):
    rel = os.path.relpath(p, d).replace("/", "_")[:-4]
    im = Image.open(p).convert("RGB"); im.thumbnail((1800, 1800 * im.height // im.width + 1))
    im.save(f"{d}/preview/{rel}.jpg", quality=72)
