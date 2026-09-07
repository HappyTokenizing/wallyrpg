/* The one local light's SHADER cost, isolated: identical frozen scene, no
   balloon in it, the only difference being whether uLocalCol is black.
   Interleaved A/B/A/B in blocks of 30 frames so drift cannot favour either. */
import { boot, ROOT } from './lib.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:6000 });
const res = await page.evaluate(async () => {
  WALLY.debug.setHour(13); WALLY.debug.balloon(false);
  await new Promise(r => setTimeout(r, 4000));
  const g = WALLY.ctx.mat.globals, info = WALLY.ctx.render?.renderer?.info || WALLY.ctx.renderer.info;
  const c = g.uLocalCol.value;
  g.uLocalPos.value.set(WALLY.ctx.camera.position.x, WALLY.ctx.camera.position.y, WALLY.ctx.camera.position.z);
  g.uLocalRange.value = 120;                 // reach the whole visible scene
  const block = (lit) => new Promise(r => {
    c.setRGB(lit ? 1.2 : 0, lit ? 0.4 : 0, lit ? 0.08 : 0);
    const d = []; let last = performance.now(); let n = 0;
    const tick = () => { const t = performance.now(); if (n > 4) d.push(t - last); last = t;
      if (++n < 34) requestAnimationFrame(tick); else r({ d, calls: info.render.calls, tris: info.render.triangles }); };
    requestAnimationFrame(tick);
  });
  const A = [], B = [];
  let ca=0, cb=0, ta=0, tb=0;
  for (let i = 0; i < 12; i++) {
    const on = await block(true);  A.push(...on.d);  ca = on.calls; ta = on.tris;
    const off = await block(false); B.push(...off.d); cb = off.calls; tb = off.tris;
  }
  c.setRGB(0,0,0);
  const med = a => { const s=[...a].sort((x,y)=>x-y); return +s[s.length>>1].toFixed(3); };
  const mean = a => +(a.reduce((x,y)=>x+y,0)/a.length).toFixed(3);
  return { nLit: A.length, nDark: B.length,
    msLit: med(A), msDark: med(B), meanLit: mean(A), meanDark: mean(B),
    fpsLit: +(1000/med(A)).toFixed(1), fpsDark: +(1000/med(B)).toFixed(1),
    callsLit: ca, callsDark: cb, trisLit: ta, trisDark: tb };
});
await close();
console.log(JSON.stringify(res, null, 1));
await writeFile(join(ROOT,'shots/j2/perf3.json'), JSON.stringify({res,errors},null,1));
