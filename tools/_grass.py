import sys, colorsys
from PIL import Image
import numpy as np
"""SAME MATERIAL BY CONSTRUCTION. Take only the pixels where green is
the dominant channel by a clear margin — that is the grass field and
nothing else — then split those by luma into the lit half and the
shaded half. Both samples are then the same surface under the two ends
of the ramp, which is what the shade law is supposed to relate."""
for p in sys.argv[1:]:
    A = np.asarray(Image.open(p).convert('RGB'), dtype=np.float32)/255.0
    A = A[130:820, 200:1400].reshape(-1,3)
    g = (A[:,1] > A[:,0]*1.12) & (A[:,1] > A[:,2]*1.12) & (A[:,1] > 0.10)
    G = A[g]
    if G.shape[0] < 5000: print(f"{p}: only {G.shape[0]} grass px"); continue
    L = 0.2126*G[:,0]+0.7152*G[:,1]+0.0722*G[:,2]
    lo, hi = np.percentile(L,15), np.percentile(L,85)
    for name, sel in (('lit', L>=hi), ('shade', L<=lo)):
        m = G[sel].mean(axis=0); h,s,v = colorsys.rgb_to_hsv(*m)
        print(f"{p.split('/')[-1]:22s} {name:5s} RGB {m[0]:.3f} {m[1]:.3f} {m[2]:.3f}  "
              f"#{int(m[0]*255):02X}{int(m[1]*255):02X}{int(m[2]*255):02X}  H {h*360:5.1f}  S {s:.3f}  V {v:.3f}  n {sel.sum()}")
