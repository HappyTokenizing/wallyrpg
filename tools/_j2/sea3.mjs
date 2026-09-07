/* THE OCEAN, with the fix and without it, everything else identical.
   "Without" pins uWaveFade back to the authored values every frame, which
   is exactly what the code did before flySea(). */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT, 'shots/j2/sea3'); await mkdir(OUT, { recursive:true });
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:5000 });
const shore = await page.evaluate(() => {
  WALLY.debug.setHour(13); WALLY.ctx.wind.setStrength(0.30);
  const raf=window.requestAnimationFrame.bind(window); window.__FROZEN=null;
  window.requestAnimationFrame=(cb)=>raf(t=>cb(window.__FROZEN!==null?window.__FROZEN:t));
  window.__FREEZE=(on)=>{ window.__FROZEN = on ? performance.now() : null; };
  window.__OCEAN=(h)=>{ WALLY.ctx.scene.traverse(o=>{ if(o.material?.uniforms?.uWaveFade) o.layers.set(h?31:0); }); };
  window.__AUTH = null;
  /* PIN THE UNIFORM AT THE SOURCE. flySea() runs in wally.js's lateUpdate,
     after which the frame is drawn, so a value written from a rAF callback
     is overwritten before it can ever be rendered. Neutering Vector2.set on
     the four fade vectors is the one place the write can be refused. */
  window.__NOFIX = (on) => {
    const f = WALLY.ctx.water.uniforms.uWaveFade.value;
    if (!window.__AUTH) window.__AUTH = f.map(v => [v.x, v.y]);
    f.forEach((v, i) => {
      if (!v.__set) v.__set = v.set.bind(v);
      if (on) { v.__set(window.__AUTH[i][0], window.__AUTH[i][1]); v.set = () => v; }
      else { v.set = v.__set; }
    });
  };
  let best=null;
  for (let x=-620;x<=620;x+=20) for (let z=-620;z<=620;z+=20) {
    const h=WALLY.debug.worldHeight(x,z);
    if (h.y<0.4||h.y>4||h.shore>8) continue;
    const l=Math.hypot(x,z)||1; let open=0;
    for (let r=200;r<=800;r+=100){ const g=WALLY.debug.worldHeight(x+x/l*r,z+z/l*r); if(g.y<0.2) open++; }
    if(!best||open>best.open) best={x,z,open};
  } return best;
});
const pump=(n=40)=>page.evaluate(k=>new Promise(r=>{ let i=0;
  const t=()=>{ window.__PIN&&window.__PIN(); window.__HOLD&&window.__HOLD(); if(++i>=k) r(); else requestAnimationFrame(t); };
  requestAnimationFrame(t); }),n);
const rows=[];
for (const alt of [90,120,200]) for (const fix of [true,false]) {
  await page.evaluate(({alt,shore,fix})=>{
    WALLY.debug.balloon(false);
    WALLY.debug.wallyWarp(shore.x, undefined, shore.z);
    WALLY.debug.balloon({ alt }); WALLY.debug.balloonStick(0,0);
    WALLY.debug.camFree();
    const w=WALLY.ctx.wally.position.clone();
    const l=Math.hypot(shore.x,shore.z)||1, dx=shore.x/l, dz=shore.z/l;
    window.__PIN=()=>{ const c=WALLY.ctx.camera; c.position.set(w.x,w.y+2.0,w.z);
      c.lookAt(w.x+dx*700,0,w.z+dz*700); c.fov=55; c.updateProjectionMatrix(); c.updateMatrixWorld(true); };
    window.__PIN(); window.__NOFIX(!fix);
  },{alt,shore,fix});
  await pump(120); await page.waitForTimeout(2000); await pump(120);
  await page.evaluate(()=>window.__FREEZE(true)); await pump(20);
  const tag=`a${alt}_${fix?'fix':'nofix'}`;
  const on=join(OUT,tag+'.png'); await page.screenshot({path:on,animations:'allow',timeout:40000});
  await page.evaluate(()=>window.__OCEAN(true)); await pump(20);
  const off=join(OUT,tag+'_noocean.png'); await page.screenshot({path:off,animations:'allow',timeout:40000});
  const st=await page.evaluate(()=>{ window.__OCEAN(false); window.__FREEZE(false);
    const f=WALLY.ctx.water.uniforms.uWaveFade.value;
    return { fogFar:+(WALLY.ctx.scene.fog?.far??0).toFixed(0), fades:f.map(v=>+v.y.toFixed(0)) }; });
  rows.push({alt,fix,on,off,tag,...st}); console.log(tag, JSON.stringify(st));
}
await close();
await writeFile(join(OUT,'index.json'), JSON.stringify(rows,null,1));
console.log(JSON.stringify({errors:errors.slice(0,4)}));
