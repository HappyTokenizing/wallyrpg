"""The same band-pass, but only in the FAR FIELD — the strip of ocean
immediately below the horizon, which is where a wave carried past its own
tessellation shows. The strip is the top 22% of the ocean mask's rows."""
import json, numpy as np
from PIL import Image
from scipy import ndimage
rows=json.load(open('shots/j2/sea2/index.json'))
def lum(a): return 0.2126*a[...,0]+0.7152*a[...,1]+0.0722*a[...,2]
print(f"{'alt':>5}{'fogFar':>8}{'fade1':>7}{'mismatch':>9}{'px':>8}{'rms':>7}{'ripple':>8}{'rev/100px':>10}")
crops=[]
for r in rows:
    a=np.asarray(Image.open(r['on']).convert('RGB'),dtype=float)
    b=np.asarray(Image.open(r['off']).convert('RGB'),dtype=float)
    m=np.abs(a-b).max(axis=2)>6
    m[:110,:]=False; m[-60:,:]=False
    m=ndimage.binary_erosion(m, np.ones((21,21)))
    ys=np.where(m.any(axis=1))[0]
    if len(ys)<40: print(f"{r['alt']:>5} too little sea"); continue
    y0,y1=ys[0], ys[0]+int(0.22*(ys[-1]-ys[0]))+8
    far=np.zeros_like(m); far[y0:y1,:]=m[y0:y1,:]
    if far.sum()<8000: print(f"{r['alt']:>5} thin far band {int(far.sum())}"); continue
    L=lum(a)
    band=ndimage.gaussian_filter(L,2.5)-ndimage.gaussian_filter(L,30)
    v=band[far]
    rms=float(np.sqrt((v**2).mean())); rip=float(np.percentile(v,99)-np.percentile(v,1))
    g=np.diff(band,axis=1); mm=far[:,1:]&far[:,:-1]; s=np.sign(g)
    rev=(s[:,1:]!=s[:,:-1])&mm[:,1:]&mm[:,:-1]&(np.abs(g[:,1:])>0.05)
    den=(mm[:,1:]&mm[:,:-1]).sum()
    mism=r['fogFar']/520.0/(r['fades'][0]/1400.0)
    print(f"{r['alt']:>5}{r['fogFar']:>8}{r['fade1'] if 'fade1' in r else r['fades'][0]:>7}{mism:>9.2f}{int(far.sum()):>8}{rms:>7.3f}{rip:>8.2f}{100*rev.sum()/max(den,1):>10.2f}")
    xs=np.where(far.any(axis=0))[0]
    crops.append((r['alt'], Image.open(r['on']).convert('RGB').crop((int(xs[0]),int(y0),int(min(xs[0]+520,xs[-1])),int(y1)))))
if crops:
    w=520; h=max(c[1].size[1] for c in crops)
    sheet=Image.new('RGB',(w, h*len(crops)),(0,0,0))
    for i,(al,c) in enumerate(crops):
        sheet.paste(c.resize((w,h)), (0,i*h))
    sheet.save('shots/j2/sea2/_farstrip.png')
    print('strip:', [c[0] for c in crops], sheet.size)
