/* WHERE are the mark pixels the keyline misses, and what are they? */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT='/Users/herwig/Documents/GitHub/wallyrpg';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 if(c==='/__b'){rs.writeHead(200,{'content-type':'text/html; charset=utf-8'});rs.end('<!doctype html><meta charset="utf-8"><title>x</title>');return;}
 try{const p=join(ROOT,c);const b=await readFile(p);rs.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--force-color-profile=srgb']});
const page=await browser.newPage({viewport:{width:900,height:900}});
await page.goto(`http://127.0.0.1:${PORT}/__b`);
const out = await page.evaluate(async (port)=>{
  const S=await import(`http://127.0.0.1:${port}/src/ui/style.js`);
  const N=1280,K=N/64;
  const raster=(inner)=>new Promise(r=>{const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${N}" height="${N}">${inner}</svg>`;
    const i=new Image();i.onload=()=>{const cv=document.createElement('canvas');cv.width=cv.height=N;const g=cv.getContext('2d');g.drawImage(i,0,0);r(g.getImageData(0,0,N,N).data);};
    i.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));});
  const mark=await raster(S.wallyMarkup('z'));
  const key =await raster(S.wallyKeyline('fill="#000" stroke="#000" stroke-width="3.4" stroke-linejoin="round"'));
  /* the mark WITHOUT tusks, for the comparison the comment implies */
  const bare=[]; const cols={};
  for(let y=0;y<N;y++)for(let x=0;x<N;x++){const i=(y*N+x)*4;
    if(mark[i+3]>40 && key[i+3]<=40){ bare.push([x/K,y/K]);
      const c=`${mark[i]},${mark[i+1]},${mark[i+2]}`; cols[c]=(cols[c]||0)+1; } }
  const xs=bare.map(p=>p[0]),ys=bare.map(p=>p[1]);
  const top=Object.entries(cols).sort((a,b)=>b[1]-a[1]).slice(0,6);
  /* how far outside, worst case: nearest keyline pixel distance for a sample */
  return { n: bare.length, x:[Math.min(...xs),Math.max(...xs)], y:[Math.min(...ys),Math.max(...ys)], top,
    /* split left/right of centre */
    left: bare.filter(p=>p[0]<32).length, right: bare.filter(p=>p[0]>=32).length,
    sample: bare.filter((_,i)=>i%Math.ceil(bare.length/12)===0).map(p=>[+p[0].toFixed(1),+p[1].toFixed(1)]) };
},PORT);
console.log(JSON.stringify(out,null,1));
await browser.close(); server.close();
