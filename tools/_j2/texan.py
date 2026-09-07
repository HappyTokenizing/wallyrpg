"""Envelope banding, measured on the exact differenced mask.

For each shot: mask = pixels that changed when the fabric+tapes+ink were
hidden. Inside the mask, split by hue into the ORANGE gores and the CREAM
gores, and per family measure

  levels   distinct luminance values holding >= 3% of the family's area
           (bin = 2 codes). Two-band banding shows up as 1-2.
  top2     fraction of the family's area in its two biggest bins.
           A flat two-tone ball is > 0.55; broken fabric is well under.
  flat     fraction of family pixels whose 3x3 luminance range is 0 or 1
           code — literally flat paint.
  ramp     mean |dL| across the family, in codes per pixel — how much
           modulation there is at all.
"""
import json, sys, os
from PIL import Image
import numpy as np

which = sys.argv[1] if len(sys.argv) > 1 else 'plain'
base = os.path.join(os.path.dirname(__file__), '../../shots/j2/tex')
rows = json.load(open(os.path.join(base, which + '-index.json')))

def lum(a):
    return 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]

out = []
for r in rows:
    on  = np.asarray(Image.open(r['on']).convert('RGB'), dtype=np.float64)
    off = np.asarray(Image.open(r['off']).convert('RGB'), dtype=np.float64)
    diff = np.abs(on-off).max(axis=2)
    mask = diff > 6
    # drop the HUD strips
    mask[:90,:] = False; mask[-45:,:] = False
    if mask.sum() < 4000:
        out.append({**{k:r[k] for k in ('h','az','tag','sunI')}, 'px': int(mask.sum()), 'skip': True}); continue
    L = lum(on)
    R,G,B = on[...,0], on[...,1], on[...,2]
    mx = on.max(axis=2); mn = on.min(axis=2)
    sat = np.where(mx>0, (mx-mn)/np.maximum(mx,1e-6), 0)
    # orange gores: saturated and red-dominant. cream: low saturation.
    orange = mask & (sat > 0.30) & (R > B)
    cream  = mask & (sat <= 0.30)
    rec = {k: r[k] for k in ('h','az','tag','sunI')}
    rec['px'] = int(mask.sum())
    # local 3x3 range and gradient on the whole image, sampled on the mask
    P = np.pad(L, 1, mode='edge')
    stack = np.stack([P[i:i+L.shape[0], j:j+L.shape[1]] for i in range(3) for j in range(3)])
    lo = stack.min(axis=0); hi = stack.max(axis=0)
    rng = hi - lo
    gx = np.abs(np.diff(L, axis=1, prepend=L[:, :1]))
    gy = np.abs(np.diff(L, axis=0, prepend=L[:1, :]))
    grad = np.maximum(gx, gy)
    for name, m in (('orange', orange), ('cream', cream)):
        n = int(m.sum())
        if n < 1500:
            rec[name] = {'px': n, 'thin': True}; continue
        v = L[m]
        hist, _ = np.histogram(v, bins=128, range=(0,256))
        frac = hist / n
        levels = int((frac >= 0.03).sum())
        top2 = float(np.sort(frac)[-2:].sum())
        flat = float((rng[m] <= 1.0).mean())
        ramp = float(grad[m].mean())
        rec[name] = {'px': n, 'levels': levels, 'top2': round(top2,3),
                     'flat': round(flat,3), 'ramp': round(ramp,3),
                     'p5': round(float(np.percentile(v,5)),1),
                     'p95': round(float(np.percentile(v,95)),1)}
    out.append(rec)

print(f"{'tag':<16}{'sunI':>6}{'|':>2} {'orange: lv top2  flat  ramp  p5-p95':<40} {'cream: lv top2  flat  ramp  p5-p95'}")
worst = []
for r in out:
    if r.get('skip'): print(f"{r['tag']:<16} SKIP px={r['px']}"); continue
    def f(d):
        if d.get('thin'): return f"  thin({d['px']})".ljust(40)
        return f"  {d['levels']:>2} {d['top2']:>5.3f} {d['flat']:>5.3f} {d['ramp']:>5.2f} {d['p5']:>5.1f}-{d['p95']:<5.1f}".ljust(40)
    print(f"{r['tag']:<16}{r['sunI']:>6}{'|':>2}{f(r['orange'])}{f(r['cream'])}")
    for nm in ('orange','cream'):
        d=r[nm]
        if not d.get('thin'): worst.append((d['top2'], d['flat'], d['levels'], r['tag'], nm))
worst.sort(reverse=True)
print("\nWORST top2 (most two-band):")
for w in worst[:6]: print(f"  top2={w[0]:.3f} flat={w[1]:.3f} levels={w[2]} {w[3]} {w[4]}")
flats = sorted(worst, key=lambda w:-w[1])
print("WORST flat:")
for w in flats[:6]: print(f"  flat={w[1]:.3f} top2={w[0]:.3f} levels={w[2]} {w[3]} {w[4]}")
lv = sorted(worst, key=lambda w:w[2])
print("FEWEST levels:")
for w in lv[:6]: print(f"  levels={w[2]} top2={w[0]:.3f} flat={w[1]:.3f} {w[3]} {w[4]}")
