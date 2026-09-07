import sys
from PIL import Image
import numpy as np
im = np.asarray(Image.open(sys.argv[1]).convert('RGB'), dtype=np.float32)/255.0
# optional crop x y w h
if len(sys.argv)>5:
    x,y,w,h = map(int, sys.argv[2:6]); im = im[y:y+h, x:x+w]
L = 0.2126*im[...,0]+0.7152*im[...,1]+0.0722*im[...,2]
def pc(p): return float(np.percentile(L,p))
print(f"px {L.size}  min {L.min():.4f}  p1 {pc(1):.4f}  p5 {pc(5):.4f}  p50 {pc(50):.4f}  p95 {pc(95):.4f}  max {L.max():.4f}")
print(f"  frac<0.02 {float((L<0.02).mean()):.3f}   <0.05 {float((L<0.05).mean()):.3f}   <0.10 {float((L<0.10).mean()):.3f}   >0.95 {float((L>0.95).mean()):.3f}")
# chroma of the darkest decile: is the shadow blue-violet or grey-black?
m = L < np.percentile(L,10)
d = im[m]
if d.size:
    mean = d.mean(axis=0)
    print(f"  darkest decile mean RGB {mean[0]:.4f} {mean[1]:.4f} {mean[2]:.4f}  (B-R {mean[2]-mean[0]:+.4f})")
    sat = (d.max(axis=1)-d.min(axis=1))/np.maximum(d.max(axis=1),1e-5)
    print(f"  darkest decile mean HSV-S {sat.mean():.3f}")
