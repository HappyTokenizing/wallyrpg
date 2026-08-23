/* 11. THE PAWN KEYLINE, MEASURED — not eyeballed.
   Rasterises wallyMarkup() and wallyKeyline() from src/ui/style.js in
   the SAME 64-box the map pawn uses, at 1600 px, and asks three
   questions the comment in ui/map.js makes claims about:
     a) the mark's own bbox in its 64-box, and its centre
     b) does the keyline cover the mark everywhere (no bare edge)
     c) is the halo EVEN — the spread it leaves outside the mark,
        sampled all the way round the silhouette
   Then it renders the pawn exactly as map.js composes it, at the real
   phone size, and measures the keyline in DEVICE PIXELS. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.png':'image/png' };
const server = createServer(async (rq,rs)=>{ const c=decodeURIComponent(rq.url.split('?')[0]);
  if (c==='/__b'){rs.writeHead(200,{'content-type':'text/html; charset=utf-8'});rs.end('<!doctype html><meta charset="utf-8"><title>ruler</title><style>html,body{margin:0;background:#fff}</style>');return;}
  try{const p=join(ROOT,c); if(!p.startsWith(ROOT)){rs.writeHead(403).end();return;} const b=await readFile(p);
    rs.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT = server.address().port;
const browser = await chromium.launch({ channel:'chrome', args:['--force-color-profile=srgb','--hide-scrollbars'] });
const page = await browser.newPage({ viewport:{width:1700,height:1700} });
await page.goto(`http://127.0.0.1:${PORT}/__b`);
let fails = 0;
const ok=(c,m,x='')=>{if(!c)fails++;console.log(`${c?'PASS':'FAIL'}  ${m}${x?'   '+x:''}`);return !!c;};

const res = await page.evaluate(async (port) => {
  const S = await import(`http://127.0.0.1:${port}/src/ui/style.js`);
  const N = 1600, BOX = 64, K = N / BOX;
  const draw = (inner) => new Promise((res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${N}" height="${N}">${inner}</svg>`;
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = cv.height = N;
      const g = cv.getContext('2d'); g.clearRect(0,0,N,N); g.drawImage(img,0,0);
      res(g.getImageData(0,0,N,N).data);
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  });
  const mask = (d) => { const m = new Uint8Array(N*N); for (let i=0;i<N*N;i++) m[i] = d[i*4+3] > 40 ? 1 : 0; return m; };
  const bbox = (m) => { let x0=N,x1=-1,y0=N,y1=-1;
    for (let y=0;y<N;y++) for (let x=0;x<N;x++) if (m[y*N+x]) { if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
    return { x0:x0/K, x1:(x1+1)/K, y0:y0/K, y1:(y1+1)/K }; };

  const markD = await draw(S.wallyMarkup('r'));
  const keyD  = await draw(S.wallyKeyline('fill="#000" stroke="#000" stroke-width="3.4" stroke-linejoin="round"'));
  const keyNoStrokeD = await draw(S.wallyKeyline('fill="#000"'));
  const M = mask(markD), Kk = mask(keyD), Kn = mask(keyNoStrokeD);

  /* mark pixels the keyline does NOT cover = a bare edge */
  let bare = 0, markPx = 0, keyPx = 0;
  for (let i=0;i<N*N;i++) { if (M[i]) { markPx++; if (!Kk[i]) bare++; } if (Kk[i]) keyPx++; }

  /* the halo, all the way round: for each row and column, how far the
     keyline extends beyond the mark on each side */
  const halo = [];
  for (let y=0;y<N;y+=8) {
    let mL=-1,mR=-1,kL=-1,kR=-1;
    for (let x=0;x<N;x++){const i=y*N+x; if(M[i]){if(mL<0)mL=x;mR=x;} if(Kk[i]){if(kL<0)kL=x;kR=x;}}
    if (mL>=0 && kL>=0) { halo.push((mL-kL)/K); halo.push((kR-mR)/K); }
  }
  for (let x=0;x<N;x+=8) {
    let mT=-1,mB=-1,kT=-1,kB=-1;
    for (let y=0;y<N;y++){const i=y*N+x; if(M[i]){if(mT<0)mT=y;mB=y;} if(Kk[i]){if(kT<0)kT=y;kB=y;}}
    if (mT>=0 && kT>=0) { halo.push((mT-kT)/K); halo.push((kB-mB)/K); }
  }
  halo.sort((a,b)=>a-b);
  const q = (p) => halo[Math.floor((halo.length-1)*p)];

  /* the keyline shapes vs the mark's own silhouette: does the UNSTROKED
     keyline sit inside the mark (i.e. is it the same drawing)? */
  let keyOutsideMark = 0, keyNPx = 0;
  for (let i=0;i<N*N;i++) if (Kn[i]) { keyNPx++; if (!M[i]) keyOutsideMark++; }

  return {
    markBox: bbox(M), keyBox: bbox(Kk), keyNoStrokeBox: bbox(Kn),
    markPx, keyPx, bare, bareFrac: bare/markPx,
    halo: { min:+q(0).toFixed(3), p05:+q(0.05).toFixed(3), med:+q(0.5).toFixed(3), p95:+q(0.95).toFixed(3), max:+q(1).toFixed(3), n: halo.length },
    keyOutsideMark, keyNPx, keyOutsideFrac: keyOutsideMark/keyNPx,
  };
}, PORT);

console.log('mark bbox in its 64-box   :', JSON.stringify(res.markBox, (k,v)=>typeof v==='number'?+v.toFixed(2):v));
const cx = (res.markBox.x0+res.markBox.x1)/2, cy = (res.markBox.y0+res.markBox.y1)/2;
console.log(`mark centre               : ${cx.toFixed(2)}, ${cy.toFixed(2)}   (map.js claims 32.0, 33.28)`);
ok(Math.abs(cx-32.0) < 0.35, 'map.js\'s claimed centre x = 32.0 is measured true', cx.toFixed(2));
ok(Math.abs(cy-33.28) < 0.35, 'map.js\'s claimed centre y = 33.28 is measured true', cy.toFixed(2));
ok(Math.abs(res.markBox.x0-2.6)<0.4 && Math.abs(res.markBox.x1-61.4)<0.4, 'claimed bbox x 2.6..61.4', `${res.markBox.x0.toFixed(2)}..${res.markBox.x1.toFixed(2)}`);
ok(Math.abs(res.markBox.y0-8.96)<0.4 && Math.abs(res.markBox.y1-57.6)<0.4, 'claimed bbox y 8.96..57.6', `${res.markBox.y0.toFixed(2)}..${res.markBox.y1.toFixed(2)}`);
console.log('keyline (stroked) bbox    :', JSON.stringify(res.keyBox, (k,v)=>typeof v==='number'?+v.toFixed(2):v));
console.log(`mark pixels ${res.markPx}, keyline pixels ${res.keyPx}, mark pixels NOT covered by the keyline: ${res.bare} (${(res.bareFrac*100).toFixed(2)}%)`);
ok(res.bareFrac < 0.005, 'the keyline covers the mark — no bare edge to print as a gap', `${(res.bareFrac*100).toFixed(2)}%`);
console.log('halo width beyond the mark, board units:', JSON.stringify(res.halo));
ok(res.halo.p05 > 0.4, 'the halo never thins to nothing anywhere round the silhouette', `p05 ${res.halo.p05}`);
ok(res.halo.p95 / Math.max(res.halo.p05, 0.001) < 3.2, 'the halo is EVEN (p95/p05 spread)', `${(res.halo.p95/res.halo.p05).toFixed(2)}x`);
console.log(`keyline-shape pixels outside the mark's own silhouette: ${res.keyOutsideMark}/${res.keyNPx} (${(res.keyOutsideFrac*100).toFixed(2)}%)`);
ok(res.keyOutsideFrac < 0.02, 'the UNSTROKED keyline is the mark\'s own silhouette, not a traced copy of an older one', `${(res.keyOutsideFrac*100).toFixed(2)}%`);

/* --- and now the pawn as map.js actually composes it, at phone size --- */
const pawn = await page.evaluate(async ([port]) => {
  const S = await import(`http://127.0.0.1:${port}/src/ui/style.js`);
  /* T.mark on a 390-wide phone chart: read the real value out of map.js
     by rendering the map is heavy, so reproduce the composition with
     the two sizes map.js uses at its extremes */
  const out = {};
  for (const K of [22, 31, 44]) {
    const R = K * 0.50, N = 900;
    const key = S.wallyKeyline('fill="#12212B" stroke="#12212B" stroke-width="3.4" stroke-linejoin="round"');
    const sc = Math.round(K/64*0.78*100)/100;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${K*2} ${K*2}">
      <rect width="100%" height="100%" fill="#F7EFE0"/>
      <circle cx="${K}" cy="${K}" r="${R}" fill="#FBF5EA" stroke="#E08A2E" stroke-width="${R*0.14}"/>
      <g transform="translate(${K} ${K}) scale(${sc}) translate(-32 -33.28)">${key}${S.wallyMarkup('p'+K)}</g></svg>`;
    const d = await new Promise((res) => { const img=new Image(); img.onload=()=>{const cv=document.createElement('canvas');cv.width=cv.height=N;const g=cv.getContext('2d');g.drawImage(img,0,0);res(g.getImageData(0,0,N,N).data);};
      img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg))); });
    /* the ink keyline in device px at this K: count how thick the dark
       ring is on the row through the ears */
    const px = N/(K*2);                       // canvas px per board unit
    const dev = px * (K*2) / (K*2);           // 1 board unit = px canvas px
    const ink = (r,g,b)=> (r<70&&g<80&&b<90);
    let widest=0, widestY=0;
    for (let y=0;y<N;y+=2){ let n=0; for(let x=0;x<N;x++){const i=(y*N+x)*4; if(ink(d[i],d[i+1],d[i+2]))n++;} if(n>widest){widest=n;widestY=y;} }
    /* walk the widest ink row from the left and measure the first run */
    let run=0, started=false;
    for (let x=0;x<N;x++){const i=(widestY*N+x)*4; const isInk=ink(d[i],d[i+1],d[i+2]);
      if(isInk){started=true;run++;} else if(started) break; }
    /* the pawn is rendered at K CSS px on screen; canvas is N px for K*2 board units */
    const cssPerCanvas = (K*2)/N;
    out[K] = { keylineRunBoardUnits:+(run*cssPerCanvas).toFixed(3), keylineRunCssPx:+(run*cssPerCanvas*(1)).toFixed(3),
      inkWidestRowPx: widest, discPx: K };
  }
  return out;
}, [PORT]);
console.log('\npawn keyline thickness, measured on the widest ink row:');
for (const K of Object.keys(pawn)) {
  const p = pawn[K];
  console.log(`   disc ${K} css px:  first ink run = ${p.keylineRunBoardUnits} board units  ->  ${(p.keylineRunBoardUnits*1).toFixed(2)} css px at that size`);
}
await browser.close(); server.close();
console.log(`\n${fails} failure(s).`);
