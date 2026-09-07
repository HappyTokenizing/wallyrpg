#!/usr/bin/env python3
# ============================================================
# _k30-an.py — the judge's analyser. Same arithmetic as
# _k29-crawl.mjs's PY block (E, A, H, all RMS over the sequence),
# run offline over kept frames so the regions and the controls can be
# chosen after looking at the pixels.
#
#   E_k = C_k - R_k     sampling error against the supersampled truth
#   A_k = E_k+1 - E_k   how it moves
#   H_k = second difference of E   how it JUMPS  <- the crawl column
#
# THE CONTROLS THIS ADDS
#   --blur S   analyse a Gaussian-blurred copy of BOTH sequences. The
#              motion is bit-identical; only the high-frequency content
#              is gone. If cH survives that, it is not measuring
#              high-frequency sampling error.
#   region 'sky' etc. are passed on the command line, so a flat,
#              moving region can be scored beside a detailed one from
#              the same frames at the same image speed.
# ============================================================
import sys, os, json, argparse
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('root')
ap.add_argument('--regions', default='')      # name:x,y,w,h  (SURFACE px) ; repeatable, comma-joined by ';'
ap.add_argument('--blur', type=float, default=0.0)
ap.add_argument('--ref', default='ref')
ap.add_argument('--ship', default='pr1_264ms2')
ap.add_argument('--n', type=int, default=0)
A = ap.parse_args()

def luma(p):
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
    return 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]

def gauss(a, s):
    if s <= 0: return a
    r = int(3*s); x = np.arange(-r, r+1); k = np.exp(-x*x/(2*s*s)); k /= k.sum()
    b = np.apply_along_axis(lambda v: np.convolve(v, k, mode='same'), 1, a)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode='same'), 0, b)

def seq(tag):
    d = os.path.join(A.root, tag)
    fs = sorted(f for f in os.listdir(d) if f.endswith('.png'))
    if A.n: fs = fs[:A.n]
    return [gauss(luma(os.path.join(d, f)), A.blur) for f in fs]

rms = lambda x: float(np.sqrt((np.asarray(x)**2).mean()))

def cut(a, r):
    x, y, w, h = r
    return a[y:y+h, x:x+w]

def shift_px(a, b):
    a = a - a.mean(); b = b - b.mean()
    w = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    Af = np.fft.fft2(a*w); Bf = np.fft.fft2(b*w)
    R = Af*np.conj(Bf); R /= np.maximum(np.abs(R), 1e-9)
    c = np.fft.ifft2(R).real
    j, i = np.unravel_index(np.argmax(c), c.shape)
    dy = j - c.shape[0] if j > c.shape[0]//2 else j
    dx = i - c.shape[1] if i > c.shape[1]//2 else i
    return float(np.hypot(dx, dy))

def metrics(C, R, r):
    Cc = [cut(f, r) for f in C]; Rc = [cut(f, r) for f in R]
    E = [Cc[i]-Rc[i] for i in range(len(Cc))]
    Aa = [E[i+1]-E[i] for i in range(len(E)-1)]
    Hh = [E[i+1]-2*E[i]+E[i-1] for i in range(1, len(E)-1)]
    return dict(sE=round(np.mean([rms(e) for e in E]), 4),
                cA=round(np.mean([rms(a) for a in Aa]), 4),
                cH=round(np.mean([rms(h) for h in Hh]), 4),
                cH99=round(float(np.mean([np.percentile(np.abs(h), 99) for h in Hh])), 3))

regions = {}
for part in [p for p in A.regions.split(';') if p.strip()]:
    name, nums = part.split(':')
    regions[name] = [int(v) for v in nums.split(',')]

tags = [d for d in sorted(os.listdir(A.root)) if os.path.isdir(os.path.join(A.root, d))]
R = seq(A.ref)
if not regions:
    regions['all'] = [0, 0, R[0].shape[1], R[0].shape[0]]

print(f"# {A.root}   {len(R)} frames   blur sigma {A.blur} surface px   ref '{A.ref}'")
for rn, r in regions.items():
    Rc = [cut(f, r) for f in R]
    spd = float(np.median([shift_px(Rc[i+1], Rc[i]) for i in range(len(Rc)-1)]))
    dl = float(np.median([np.abs(Rc[i+1]-Rc[i]).mean() for i in range(len(Rc)-1)]))
    # how much high-frequency content the region actually has
    gx = np.abs(np.diff(Rc[0], axis=1)); hf = float(np.percentile(gx, 99))
    print(f"\n  region '{rn}' {r[2]}x{r[3]} surface px   image speed {spd:.2f} px/frame   "
          f"frame-to-frame luma {dl:.3f} levels   p99 |dx| (detail) {hf:.2f} levels")
    ship = None
    rows = []
    for t in tags:
        if t == A.ref: continue
        m = metrics(seq(t), R, r)
        rows.append((t, m))
        if t == A.ship: ship = m
    print('      ' + 'sequence'.ljust(14) + 'sE'.rjust(9) + 'cA'.rjust(9) + 'cH'.rjust(9) + 'cH99'.rjust(9) + '     vs shipped')
    for t, m in rows:
        rel = ''
        if ship and t != A.ship: rel = f"cH {m['cH']/ship['cH']:.3f}x   sE {m['sE']/ship['sE']:.3f}x" if ship['cH'] else 'ship cH = 0'
        elif t == A.ship: rel = '(shipped)'
        print('      ' + t.ljust(14) + f"{m['sE']:9.4f}{m['cA']:9.4f}{m['cH']:9.4f}{m['cH99']:9.3f}     " + rel)
