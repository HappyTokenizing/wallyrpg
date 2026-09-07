#!/usr/bin/env python3
"""Contact sheet: rows = builds, cols = minutes. No colour management,
no resampling filter that invents colour (BOX only), labels drawn in a
gutter so nothing is painted over the sky being judged."""
import sys, os
from PIL import Image, ImageDraw

out = sys.argv[1]
mode = sys.argv[2]
minutes = sys.argv[3].split(',')
dirs = {}
for spec in sys.argv[4:]:
    name, d = spec.split('=')
    dirs[name] = d

CW, CH = 300, 169
GUT_L, GUT_T = 64, 20
W = GUT_L + CW * len(minutes)
H = GUT_T + CH * len(dirs)
sheet = Image.new('RGB', (W, H), (24, 24, 24))
dr = ImageDraw.Draw(sheet)
for ci, m in enumerate(minutes):
    dr.text((GUT_L + ci * CW + 4, 5), f'{m[:2]}:{m[2:]}', fill=(230, 230, 230))
for ri, (name, d) in enumerate(dirs.items()):
    dr.text((4, GUT_T + ri * CH + CH // 2), name, fill=(230, 230, 230))
    for ci, m in enumerate(minutes):
        p = os.path.join(d, f'{name}-{m}-{mode}.png')
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert('RGB').resize((CW, CH), Image.BOX)
        sheet.paste(im, (GUT_L + ci * CW, GUT_T + ri * CH))
sheet.save(out)
print(out, sheet.size)
