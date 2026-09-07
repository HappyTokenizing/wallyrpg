import sys, glob
from PIL import Image
import numpy as np
"""THE NAMED REGRESSION: no two-band terminator on the envelope, at any
sun bearing. The envelope is the large saturated non-sky, non-ground
blob in the upper half; take horizontal scanlines across it and report
the largest single-pixel luma step and the longest flat run. A two-band
terminator IS a step: one big jump with flat plateaus either side."""
for f in sorted(sys.argv[1:]):
    A = np.asarray(Image.open(f).convert('RGB'), dtype=np.float32)/255.0
    # envelope: upper-middle box around the camera target
    box = A[120:420, 380:820]
    L = 0.2126*box[...,0]+0.7152*box[...,1]+0.0722*box[...,2]
    # keep only rows that actually cross the envelope (high local sat)
    S = (box.max(axis=2)-box.min(axis=2))/np.maximum(box.max(axis=2),1e-5)
    rows = np.where((S > 0.30).sum(axis=1) > 120)[0]
    if len(rows) < 8: print(f"{f.split('/')[-1]:24s} no envelope rows found"); continue
    steps, runs = [], []
    for r in rows:
        v = L[r][S[r] > 0.30]
        if len(v) < 60: continue
        v = np.convolve(v, np.ones(3)/3, mode='valid')   # kill the grain, keep a band edge
        d = np.abs(np.diff(v))
        steps.append(d.max())
        run, best = 1, 1
        for i in range(1, len(v)):
            if abs(v[i]-v[i-1]) < 0.004: run += 1; best = max(best, run)
            else: run = 1
        runs.append(best)
    steps, runs = np.array(steps), np.array(runs)
    print(f"{f.split('/')[-1]:24s} rows {len(steps):3d}  max 1px step {steps.max()*255:6.2f}/255  "
          f"p95 {np.percentile(steps,95)*255:6.2f}  median flat run {np.median(runs):5.1f}px  max run {runs.max():3d}px")
