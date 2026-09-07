"""Striping on the open sea, on the exact ocean mask.

The patch is the ocean's own pixels, minus a 12 px erode so no silhouette
edge is in it. Inside it the luminance is high-passed against a 9 px box
mean; RMS and p1-p99 of the residual are the RIPPLE in 8-bit codes, and
gradient sign reversals along each row, divided by the row's length, are
the REVERSALS PER PIXEL. Both are computed only where the mask is solid.
"""
import json, numpy as np
from PIL import Image
from scipy import ndimage
rows=json.load(open('shots/j2/sea2/index.json'))
def lum(a): return 0.2126*a[...,0]+0.7152*a[...,1]+0.0722*a[...,2]
print(f"{'alt':>5}{'camY':>7}{'fogFar':>8}{'fade1':>7}{'ratio':>7}{'px':>9}{'rms':>7}{'p1-99':>8}{'rev/px':>8}{'rev/row':>9}")
out=[]
for r in rows:
    a=np.asarray(Image.open(r['on']).convert('RGB'),dtype=float)
    b=np.asarray(Image.open(r['off']).convert('RGB'),dtype=float)
    m=np.abs(a-b).max(axis=2)>6
    m[:110,:]=False; m[-60:,:]=False
    m=ndimage.binary_erosion(m, np.ones((13,13)))
    if m.sum()<20000:
        print(f"{r['alt']:>5}{r['camY']:>7}{r['fogFar']:>8}  too little sea ({int(m.sum())})"); continue
    L=lum(a)
    base=ndimage.uniform_filter(L, size=9)
    hp=(L-base)
    v=hp[m]
    rms=float(np.sqrt((v**2).mean())); p=float(np.percentile(v,99)-np.percentile(v,1))
    # gradient reversals along rows, only inside runs of mask
    g=np.diff(L,axis=1)
    mm=m[:,1:]&m[:,:-1]
    s=np.sign(g)
    rev=(s[:,1:]!=s[:,:-1]) & mm[:,1:] & mm[:,:-1] & (np.abs(g[:,1:])>0.6)
    denom=(mm[:,1:]&mm[:,:-1]).sum()
    revpx=rev.sum()/max(denom,1)
    rowlens=(mm[:,1:]&mm[:,:-1]).sum(axis=1)
    nrows=(rowlens>50).sum()
    revrow=rev.sum()/max(nrows,1)
    ratio=r['fogFar']/520.0/(r['fades'][0]/1400.0)
    print(f"{r['alt']:>5}{r['camY']:>7}{r['fogFar']:>8}{r['fades'][0]:>7}{ratio:>7.2f}{int(m.sum()):>9}{rms:>7.3f}{p:>8.2f}{revpx:>8.4f}{revrow:>9.2f}")
    out.append((r['alt'],rms,p,revpx,revrow))
