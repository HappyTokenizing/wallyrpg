"""Striping on the open sea — BAND-passed, so the film grain (1 px) and the
overall depth gradient (hundreds of px) are both out of the measurement and
what is left is structure at the 6-80 px scale, which is what the eye reads
as striping.

  band  = gaussian(L, 2.5) - gaussian(L, 30)
  ripple = p1..p99 of band, in 8-bit codes
  rms    = RMS of band
  rev    = sign reversals of d(band)/dx per 100 px of row
"""
import json, numpy as np
from PIL import Image
from scipy import ndimage
rows=json.load(open('shots/j2/sea2/index.json'))
def lum(a): return 0.2126*a[...,0]+0.7152*a[...,1]+0.0722*a[...,2]
print(f"{'alt':>5}{'camY':>7}{'fogFar':>8}{'fade1':>7}{'mismatch':>9}{'px':>9}{'rms':>7}{'ripple':>8}{'rev/100px':>10}")
for r in rows:
    a=np.asarray(Image.open(r['on']).convert('RGB'),dtype=float)
    b=np.asarray(Image.open(r['off']).convert('RGB'),dtype=float)
    m=np.abs(a-b).max(axis=2)>6
    m[:110,:]=False; m[-60:,:]=False
    m=ndimage.binary_erosion(m, np.ones((41,41)))
    if m.sum()<20000: print(f"{r['alt']:>5} too little sea"); continue
    L=lum(a)
    band=ndimage.gaussian_filter(L,2.5)-ndimage.gaussian_filter(L,30)
    v=band[m]
    rms=float(np.sqrt((v**2).mean()))
    rip=float(np.percentile(v,99)-np.percentile(v,1))
    g=np.diff(band,axis=1); mm=m[:,1:]&m[:,:-1]
    s=np.sign(g)
    rev=(s[:,1:]!=s[:,:-1])&mm[:,1:]&mm[:,:-1]&(np.abs(g[:,1:])>0.05)
    den=(mm[:,1:]&mm[:,:-1]).sum()
    mism=r['fogFar']/520.0/(r['fades'][0]/1400.0)
    print(f"{r['alt']:>5}{r['camY']:>7}{r['fogFar']:>8}{r['fades'][0]:>7}{mism:>9.2f}{int(m.sum()):>9}{rms:>7.3f}{rip:>8.2f}{100*rev.sum()/max(den,1):>10.2f}")
