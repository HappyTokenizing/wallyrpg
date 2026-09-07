#!/usr/bin/env python3
# ============================================================
# _k29-synth.py — THE CONTROL THAT SAYS WHAT cH IS MEASURING.
#
# _k29-crawl.mjs scores a real frame and cannot tell you whether its
# crawl column is measuring crawl or just re-measuring blur. This does,
# because here there is no world to argue about: ONE straight edge,
# translating at a known speed, rendered by the same two knobs.
#
#   buffer pixel size p   (p = 2 surface px is pixelRatio 1 at dsf 2)
#   samples per pixel n   (n = 1 is msaa 0; coverage quantised to 1/n)
#
# and then resampled to the surface the way the compositor does it —
# BILINEAR UP for a coarse buffer, AREA-AVERAGE DOWN for the
# supersampled reference. That last line is the whole file's history:
# the first version point-sampled the reference instead of averaging
# it, which made the "ground truth" an aliased 1x render with a
# different phase, and every row came out ranking resolution BACKWARDS
# on cH. The bug looked exactly like a finding.
#
# WHAT IT ESTABLISHES, and it is the reason the measurement was worth
# taking at all: sE and cH rank the two knobs DIFFERENTLY. sE follows
# resolution (2.79 -> 1.77 from pr1 to pr2, MSAA worth a tenth of
# that). cH follows SAMPLES: at 0.25 px/frame, MSAA 4 cuts it 47 %
# (3.52 -> 1.85) while quadrupling the pixels makes it WORSE
# (3.52 -> 4.40). A metric that merely re-measured blur could not do
# that. The crossover is speed: by 2 px/frame resolution helps cH too,
# because the staircase step it shrinks is now large next to the
# distance travelled in a frame.
# ============================================================
import numpy as np
SURF = 1024; NF = 48; H = 64

def resample(buf, p, surf=SURF):
    """buffer pixel size p (in surface px) -> the surface grid.
       p > 1 (coarser than the surface): the compositor UPSCALES, bilinear.
       p < 1 (finer, i.e. the supersampled reference): it DOWNSCALES, area average."""
    nb = buf.shape[1]
    if p >= 1.0:
        xi = (np.arange(surf) + 0.5) / p - 0.5
        i0 = np.clip(np.floor(xi).astype(int), 0, nb - 1)
        i1 = np.clip(i0 + 1, 0, nb - 1)
        w = (xi - i0)[None, :]
        return buf[:, i0] * (1 - w) + buf[:, i1] * w
    f = int(round(1.0 / p))                       # integer supersample factor
    return buf[:, :surf * f].reshape(buf.shape[0], surf, f).mean(axis=2)

def render(p, n, v, nf=NF, surf=SURF, slope=0.18):
    nb = int(round(surf / p))
    offs = (np.arange(n) + 0.5) / n
    xs = (np.arange(nb)[:, None] + offs[None, :]) * p
    ys = (np.arange(H) + 0.5) * 1.0
    out = []
    for k in range(nf):
        x0 = surf * 0.5 + (k - nf / 2) * v
        cov = np.stack([(xs < (x0 + slope * y)).mean(axis=1) for y in ys])
        buf = cov * 235.0 + (1 - cov) * 40.0
        out.append(resample(buf, p, surf))
    return out

def truth(v, nf=NF, surf=SURF, slope=0.18):
    return render(0.25, 4, v, nf, surf, slope)     # pr4 + msaa4, downscaled — the real reference

rms = lambda x: float(np.sqrt((np.asarray(x) ** 2).mean()))
def metrics(C, R):
    E = [C[i] - R[i] for i in range(len(C))]
    A = [E[i+1] - E[i] for i in range(len(E) - 1)]
    Hh = [E[i+1] - 2*E[i] + E[i-1] for i in range(1, len(E) - 1)]
    return dict(sE=round(np.mean([rms(e) for e in E]), 3),
                cA=round(np.mean([rms(a) for a in A]), 3),
                cH=round(np.mean([rms(h) for h in Hh]), 4))

OPTS = [('pr1     msaa0', 2.0, 1), ('pr1     msaa2', 2.0, 2), ('pr1     msaa4', 2.0, 4),
        ('pr1.264 msaa0', 2/1.264, 1), ('pr1.264 msaa2', 2/1.264, 2), ('pr1.264 msaa4', 2/1.264, 4),
        ('pr1.5   msaa0', 2/1.5, 1), ('pr1.5   msaa2', 2/1.5, 2), ('pr2     msaa0', 1.0, 1)]

print('SYNTHETIC CONTROL — one translating edge, no world, known right answer.')
print('reference = pr4 + msaa4 AREA-DOWNSCALED to the surface, exactly as the compositor does it.\n')
for v in (0.25, 0.5, 2.0, 8.0):
    R = truth(v)
    print(f'  edge speed {v} surface px/frame')
    print('    ' + 'option'.ljust(16) + 'sE'.rjust(8) + 'cA'.rjust(8) + 'cH'.rjust(9))
    for name, p, n in OPTS:
        m = metrics(render(p, n, v), R)
        print('    ' + name.ljust(16) + str(m['sE']).rjust(8) + str(m['cA']).rjust(8) + str(m['cH']).rjust(9))
    print()
