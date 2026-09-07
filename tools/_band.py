import sys
from PIL import Image
import numpy as np
im = np.asarray(Image.open(sys.argv[1]).convert('RGB'), dtype=np.float64)
x0,y0,w,h = map(int, sys.argv[2:6])
p = im[y0:y0+h, x0:x0+w]
col = p.mean(axis=1)                      # average across the strip: kills grain, keeps bands
d = np.diff(col, axis=0)
print(f"strip {w}x{h} at ({x0},{y0})  total range {col[0]}-{col[-1]}")
for ci,cn in enumerate('RGB'):
    v = col[:,ci]; dv = d[:,ci]
    # a band edge is a step of >=1/255 in the row-averaged column
    steps = int((np.abs(dv) >= 0.9).sum())
    runs = []
    cur = 1
    for i in range(1,len(v)):
        if abs(v[i]-v[i-1]) < 0.5: cur += 1
        else: runs.append(cur); cur = 1
    runs.append(cur)
    runs = np.array(runs)
    print(f"  {cn}: span {v.max()-v.min():6.2f}/255 over {h}px   steps {steps:3d}   "
          f"longest flat run {runs.max():3d}px  median run {np.median(runs):5.1f}px")
