import sys
from PIL import Image
# usage: _crop.py in.png out.png x y w h [scale]
i,o,x,y,w,h = sys.argv[1],sys.argv[2],*map(int,sys.argv[3:7])
s = float(sys.argv[7]) if len(sys.argv)>7 else 2.0
im = Image.open(i).convert('RGB').crop((x,y,x+w,y+h))
im = im.resize((int(w*s),int(h*s)), Image.NEAREST)
im.save(o); print(o, im.size)
