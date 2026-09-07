import sys
from PIL import Image
import numpy as np
ref = Image.open('shots/qp/aa-ref.png').convert('RGB').resize((1600,900), Image.BOX)
R = np.asarray(ref, dtype=np.float32)/255.0
# centre crop: the HUD is DOM and does not resample the same way
x0,y0,x1,y1 = 200,130,1400,820
R = R[y0:y1, x0:x1]
g = R.mean(axis=2)
gx = np.abs(np.diff(g, axis=1))[:-1,:]; gy = np.abs(np.diff(g, axis=0))[:,:-1]
edge = (np.hypot(gx,gy) > 0.045)
print(f"reference: {edge.mean()*100:.1f}% of the crop is an edge pixel")
for c in sys.argv[1:]:
    A = np.asarray(Image.open(f'shots/qp/aa-{c}.png').convert('RGB'), dtype=np.float32)/255.0
    A = A[y0:y1, x0:x1]
    d = np.sqrt(((A-R)**2).mean(axis=2))
    de = d[:-1,:-1][edge]; df = d[:-1,:-1][~edge]
    print(f"msaa={c:>3}  RMS vs supersampled ref: edges {de.mean()*255:6.3f}/255   flat {df.mean()*255:6.3f}/255"
          f"   whole {d.mean()*255:6.3f}/255   p99 edge {np.percentile(de,99)*255:6.2f}")
