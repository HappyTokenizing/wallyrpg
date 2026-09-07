/* THE OCEAN, swept through altitude. The ocean mask is exact — the disc is
   hidden and the frame differenced — and the world is frozen while both
   frames are taken, so nothing but the water is measured. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT, 'shots/j2/sea2');
await mkdir(OUT, { recursive: true });
const ALTS = (process.argv[2] || '0,40,70,90,110,130,150,180,200,240').split(',').map(Number);
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:5000 });

const shore = await page.evaluate(() => {
  WALLY.debug.setHour(13); WALLY.ctx.wind.setStrength(0.30);
  const raf = window.requestAnimationFrame.bind(window);
  window.__FROZEN = null;
  window.requestAnimationFrame = (cb) => raf((t)=>cb(window.__FROZEN!==null?window.__FROZEN:t));
  window.__FREEZE = (on) => { window.__FROZEN = on ? performance.now() : null; };
  window.__OCEAN = (hide) => { let n=0; WALLY.ctx.scene.traverse(o => {
    if (o.material?.uniforms?.uWaveFade) { o.layers.set(hide?31:0); n++; } }); return n; };
  let best=null;
  for (let x=-620;x<=620;x+=20) for (let z=-620;z<=620;z+=20) {
    const h=WALLY.debug.worldHeight(x,z);
    if (h.y<0.4||h.y>4||h.shore>8) continue;
    const l=Math.hypot(x,z)||1; let open=0;
    for (let r=200;r<=800;r+=100){ const g=WALLY.debug.worldHeight(x+x/l*r, z+z/l*r); if(g.y<0.2) open++; }
    if(!best||open>best.open) best={x,z,open};
  }
  return best;
});
console.log('SHORE', JSON.stringify(shore));

const pump = (n=40) => page.evaluate(k => new Promise(r => {
  let i=0; const t=()=>{ window.__PIN&&window.__PIN(); if(++i>=k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), n);

const rows=[];
for (const alt of ALTS) {
  await page.evaluate(({alt, shore}) => {
    WALLY.debug.balloon(false);
    WALLY.debug.wallyWarp(shore.x, undefined, shore.z);
    if (alt > 0) { WALLY.debug.balloon({ alt }); WALLY.debug.balloonStick(0,0); }
    WALLY.debug.camFree();
    const w = WALLY.ctx.wally.position.clone();
    const l = Math.hypot(shore.x, shore.z)||1, dx = shore.x/l, dz = shore.z/l;
    window.__PIN = () => { const c = WALLY.ctx.camera;
      c.position.set(w.x, w.y + 2.0, w.z);
      c.lookAt(w.x + dx*700, 0, w.z + dz*700);
      c.fov = 55; c.updateProjectionMatrix(); c.updateMatrixWorld(true); };
    window.__PIN();
  }, { alt, shore });
  await pump(120); await page.waitForTimeout(2500); await pump(120);
  await page.evaluate(() => window.__FREEZE(true));
  await pump(20);
  const on = join(OUT, `a${alt}.png`);
  await page.screenshot({ path:on, animations:'allow', timeout:40000 });
  await page.evaluate(() => window.__OCEAN(true));
  await pump(20);
  const off = join(OUT, `a${alt}_noocean.png`);
  await page.screenshot({ path:off, animations:'allow', timeout:40000 });
  const st = await page.evaluate(() => { window.__OCEAN(false); window.__FREEZE(false);
    const f = WALLY.ctx.water?.uniforms?.uWaveFade?.value;
    return { camY:+WALLY.ctx.camera.position.y.toFixed(1),
      fogFar:+(WALLY.ctx.scene.fog?.far??0).toFixed(0),
      fades: f ? f.map(v=>+v.y.toFixed(0)) : null }; });
  rows.push({ alt, on, off, ...st });
  console.log('alt', alt, JSON.stringify(st));
}
await close();
await writeFile(join(OUT,'index.json'), JSON.stringify(rows,null,1));
console.log(JSON.stringify({errors: errors.slice(0,4)}));
