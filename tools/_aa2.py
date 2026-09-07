import sys
from PIL import Image
import numpy as np
"""Reference-free aliasing proxy. A resolved edge spreads its step over
two pixels and shows intermediate values; an aliased edge jumps in one.
So count the very large single-pixel steps. Animation drift between
boots cannot fake this: it is a statistic of THIS frame's own edges."""
x0,y0,x1,y1 = 200,130,1400,820
for c in sys.argv[1:]:
    p = f'shots/qp/aa-{c}.png'
    A = np.asarray(Image.open(p).convert('RGB'), dtype=np.float32)/255.0
    A = A[y0:y1, x0:x1]
    g = A.mean(axis=2)
    gx = np.abs(np.diff(g, axis=1))[:-1,:]; gy = np.abs(np.diff(g, axis=0))[:,:-1]
    m = np.hypot(gx,gy)
    print(f"msaa={c:>3}  |grad| p99 {np.percentile(m,99)*255:6.2f}  p99.9 {np.percentile(m,99.9)*255:6.2f}"
          f"  frac>0.25 {(m>0.25).mean()*100:5.2f}%  frac>0.40 {(m>0.40).mean()*100:5.3f}%  mean {m.mean()*255:5.2f}")
