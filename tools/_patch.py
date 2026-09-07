import sys
from PIL import Image
import numpy as np
im = np.asarray(Image.open(sys.argv[1]).convert('RGB'), dtype=np.float32)/255.0
import colorsys
for spec in sys.argv[2:]:
    name,x,y,w,h = spec.split(',')
    x,y,w,h = int(x),int(y),int(w),int(h)
    p = im[y:y+h, x:x+w].reshape(-1,3)
    m = p.mean(axis=0)
    hsv = colorsys.rgb_to_hsv(*m)
    print(f"{name:14s} RGB {m[0]:.3f} {m[1]:.3f} {m[2]:.3f}  #{int(m[0]*255):02X}{int(m[1]*255):02X}{int(m[2]*255):02X}"
          f"  H {hsv[0]*360:5.1f}  S {hsv[1]:.3f}  V {hsv[2]:.3f}  sd {p.std(axis=0).mean():.4f}")
