import sys, colorsys
from PIL import Image
import numpy as np
A = np.asarray(Image.open(sys.argv[1]).convert('RGB'), dtype=np.float32)/255.0
for name,x,y,w,h in (('near lawn',360,560,260,40),('near lawn 2',760,545,220,30),
                     ('mid grass',700,505,200,16),('far grass',960,470,120,12)):
    p = A[y:y+h, x:x+w].reshape(-1,3)
    g = (p[:,1] > p[:,0]*1.05) & (p[:,1] > p[:,2]*1.05)
    q = p[g] if g.sum() > 50 else p
    m = q.mean(axis=0); hh,s,v = colorsys.rgb_to_hsv(*m)
    print(f"{name:12s} #{int(m[0]*255):02X}{int(m[1]*255):02X}{int(m[2]*255):02X}  H {hh*360:5.1f}  S {s:.3f}  V {v:.3f}  n {len(q)}")
