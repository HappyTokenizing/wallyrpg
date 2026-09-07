#!/usr/bin/env python3
# ============================================================
# _k30-slit.py — CRAWL WITHOUT A GROUND TRUTH, AND CRAWL YOU CAN LOOK AT.
#
# Everything in _k29-crawl is scored against a supersampled reference.
# That is the right instrument, but every number then depends on the
# reference being right, and the rig's own confessed bias — a sharp
# candidate's crawl correlates with the reference's more than a blurry
# one's — lives exactly there. This measures the same phenomenon with no
# reference in the arithmetic at all.
#
# THE IDEA. The camera path is a pure function of the step, so a feature's
# image position is a SMOOTH function of time. Take one edge's sub-pixel
# position per frame and fit a low-order polynomial to it. A perfectly
# resolved edge leaves nothing behind. A coarse grid leaves the staircase:
# the edge holds, then steps. The RMS residual, in surface pixels, IS the
# crawl, and only this option's own frames went into it.
#
# Sub-pixel position is the gradient centroid across the edge:
#     p = sum(x * |dI/dx|) / sum(|dI/dx|)
# exact for a linear ramp, unbiased for any symmetric one.
#
# TWO TRACKER FAILURES, BOTH OF WHICH READ LIKE FINDINGS, BOTH FIXED:
#   . argmax over the whole slit re-finds the STRONGEST edge every frame.
#     The slit crosses several, the winner changes, and every option
#     scores ~44 px of "crawl".
#   . a predictive window still lets one row hop to the neighbouring band.
#     The tell was the measured SPEED disagreeing 10 % with every other
#     row of the same motion — a quantity that is a property of the
#     camera path and must be identical across options.
#   --guide TAG fixes WHICH edge, from another sequence's tracked path,
#   +/- track px. It supplies identity only; the sub-pixel position, and
#   therefore every number printed, still comes from this option's pixels.
#
# AND THE PICTURE. The same slit stacked frame by frame is a space-time
# image: one axis space across the edge, the other time. A resolved edge
# draws a clean straight band; a crawling one draws a staircase. It is
# the one honest way to put motion into a still.
# ============================================================
import os, argparse
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('root')
ap.add_argument('--tags', default='')
ap.add_argument('--axis', default='v', choices=['v', 'h'])
ap.add_argument('--x', type=int, default=650)
ap.add_argument('--y', type=int, default=100)
ap.add_argument('--len', type=int, default=140)
ap.add_argument('--wide', type=int, default=1)
ap.add_argument('--out', default=None)
ap.add_argument('--zoom', type=int, default=8)
ap.add_argument('--seek0', type=int, default=0)
ap.add_argument('--seek1', type=int, default=10**9)
ap.add_argument('--track', type=int, default=8)
ap.add_argument('--fit', type=int, default=1)
ap.add_argument('--guide', default=None)
ap.add_argument('--crop', default=None)
ap.add_argument('--ship', default='pr1_264ms2')
A = ap.parse_args()

def luma(p):
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
    return 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]

def slit(img):
    if A.axis == 'v':
        return img[A.y:A.y+A.len, A.x:A.x+A.wide].mean(axis=1)
    return img[A.y:A.y+A.wide, A.x:A.x+A.len].mean(axis=0)

def load(t):
    d = os.path.join(A.root, t)
    fs = sorted(f for f in os.listdir(d) if f.endswith('.png'))
    return np.stack([slit(luma(os.path.join(d, f))) for f in fs])

def track(S, guide=None):
    g = np.abs(np.diff(S, axis=1))
    pos = []
    prev = None
    vel = 0.0
    for k in range(S.shape[0]):
        gk = g[k]
        if guide is not None:
            p0 = guide[k]
        elif prev is None:
            p0 = int(np.argmax(gk[A.seek0:min(A.seek1, len(gk))])) + A.seek0
        else:
            p0 = prev + vel
        lo, hi = max(0, int(p0) - A.track), min(len(gk), int(p0) + A.track + 1)
        c = int(np.argmax(gk[lo:hi])) + lo
        lo, hi = max(0, c - 4), min(len(gk), c + 5)
        w = gk[lo:hi]
        xs = np.arange(lo, hi) + 0.5
        p = float((xs * w).sum() / max(w.sum(), 1e-9))
        if prev is not None:
            vel = 0.6 * vel + 0.4 * (p - prev)
        prev = p
        pos.append(p)
    return np.array(pos)

tags = A.tags.split(',') if A.tags else [d for d in sorted(os.listdir(A.root))
                                         if os.path.isdir(os.path.join(A.root, d))]
guide = track(load(A.guide)) if A.guide else None

axis_name = 'x' if A.axis == 'v' else 'y'
print(f"# {A.root}   slit {A.axis} at {axis_name}={A.x if A.axis == 'v' else A.y}, "
      f"length {A.len}, {A.wide} line(s) averaged, trajectory model = degree-{A.fit} polynomial"
      + (f", edge identity guided by '{A.guide}'" if A.guide else ""))
print("# residual: RMS distance of the measured sub-pixel edge position from that smooth model,")
print("#           in SURFACE pixels. No ground truth enters the arithmetic.")
print()

panels = []
rows = []
for t in tags:
    S = load(t)
    pos = track(S, guide)
    k = np.arange(len(pos))
    co = np.polyfit(k, pos, A.fit)
    res = pos - np.polyval(co, k)
    spd = float(np.polyval(np.polyder(co), len(k) / 2))
    rows.append((t, spd, float(np.sqrt((res ** 2).mean())), float(np.abs(res).max())))
    panels.append((t, S))

ship = next((r for t, s, r, m in rows if t == A.ship), None)
print('  ' + 'sequence'.ljust(14) + 'speed px/frame'.rjust(15) + 'residual px'.rjust(13)
      + 'max dev px'.rjust(12) + 'vs shipped'.rjust(13))
for t, spd, r, mx in rows:
    rel = '    (shipped)' if t == A.ship else (f'{r / ship:12.3f}x' if ship else '')
    print('  ' + t.ljust(14) + f'{spd:15.3f}{r:13.4f}{mx:12.4f}' + rel)

if A.out:
    z = A.zoom
    a0, a1 = 0, panels[0][1].shape[1]
    if A.crop:
        a0, a1 = [int(v) for v in A.crop.split(',')]
    W = panels[0][1].shape[0] * z
    img = Image.new('RGB', (len(panels) * (W + 10), (a1 - a0) * 2), (255, 255, 255))
    for i, (t, S) in enumerate(panels):
        a = np.repeat(S.T[a0:a1], z, axis=1)
        a = np.repeat(np.clip(a, 0, 255).astype(np.uint8), 2, axis=0)
        img.paste(Image.fromarray(a).convert('RGB'), (i * (W + 10), 0))
    img.save(A.out)
    print(f"\n# space-time panels, left to right: {', '.join(t for t, _ in panels)}  ->  {A.out}")
    print(f"# each panel: x = time ({panels[0][1].shape[0]} frames, x{z}), y = slit rows {a0}..{a1} (x2)")
