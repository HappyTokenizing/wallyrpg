/* PERFORMANCE. fps and whole-frame draw calls on the ground and at altitude.
   info.autoReset is false and renderer.js raises info.reset() at the TOP of
   its render, so the only honest sample is at the END of a frame — a rAF
   registered from here, which always runs after the game's own step+draw. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:6000 });

await page.evaluate(() => {
  WALLY.debug.setHour(13);
  const info = WALLY.ctx.render?.renderer?.info || WALLY.ctx.renderer.info;
  window.__SAMPLE = (ms) => new Promise(res => {
    const rows = []; const t0 = performance.now(); let last = t0;
    const tick = () => {
      const now = performance.now();
      rows.push({ dt: now - last, calls: info.render.calls, tris: info.render.triangles,
        prog: info.programs?.length ?? 0, geo: info.memory.geometries, tex: info.memory.textures });
      last = now;
      if (now - t0 < ms) requestAnimationFrame(tick);
      else {
        const d = rows.slice(3).map(r => r.dt).sort((a,b)=>a-b);
        const c = rows.slice(3).map(r => r.calls).sort((a,b)=>a-b);
        const t = rows.slice(3).map(r => r.tris).sort((a,b)=>a-b);
        const q = (a,p) => a[Math.min(a.length-1, Math.floor(a.length*p))];
        res({ n: d.length,
          fpsMean: +(1000 / (d.reduce((x,y)=>x+y,0)/d.length)).toFixed(1),
          msP50: +q(d,0.5).toFixed(2), msP95: +q(d,0.95).toFixed(2), msMax: +d[d.length-1].toFixed(2),
          callsP50: q(c,0.5), callsMax: c[c.length-1],
          trisP50: q(t,0.5), trisMax: t[t.length-1],
          geo: rows[rows.length-1].geo, tex: rows[rows.length-1].tex,
          hulls: WALLY.debug.outline().hulls, drawn: WALLY.debug.outline().hullsDrawn });
      }
    };
    requestAnimationFrame(tick);
  });
});

const out = {};
for (const [name, alt] of [['ground', 0], ['alt60', 60], ['alt120', 120], ['alt200', 200]]) {
  await page.evaluate((a) => { WALLY.debug.balloon(false);
    if (a > 0) { WALLY.debug.balloon({ alt: a }); WALLY.debug.balloonStick(0,0); } }, alt);
  await page.waitForTimeout(6000);            // let the world stream in
  await page.evaluate(() => window.__SAMPLE(1500));   // warm
  out[name] = await page.evaluate(() => window.__SAMPLE(6000));
  console.log(name, JSON.stringify(out[name]));
}

/* THE MACHINE'S OWN COST, differenced across whole frames — the project's
   own hook, which toggles `visible` on alternate frames and samples at the
   end of each. Run at both heights. */
for (const [name, alt] of [['cost-ground', 6], ['cost-alt200', 200]]) {
  await page.evaluate((a) => { WALLY.debug.balloon(false); WALLY.debug.balloon({ alt: a }); WALLY.debug.balloonStick(0,0); }, alt);
  await page.waitForTimeout(4000);
  out[name] = await page.evaluate(() => WALLY.debug.balloonCost(40));
  console.log(name, JSON.stringify(out[name]));
}

/* AND THE OUTLINE'S OWN COST at altitude: hulls to a dead layer, differenced. */
out.inkCost = await page.evaluate(async () => {
  const info = WALLY.ctx.render?.renderer?.info || WALLY.ctx.renderer.info;
  const hs = []; WALLY.ctx.scene.traverse(o => { if (o.userData?.isOutlineHull) hs.push(o); });
  const run = (hide) => new Promise(res => {
    hs.forEach(h => h.layers.set(hide ? 31 : 0));
    const rows = []; let n = 0;
    const tick = () => { rows.push({ c: info.render.calls, t: info.render.triangles, dt: performance.now() });
      if (++n < 90) requestAnimationFrame(tick); else res(rows.slice(20)); };
    requestAnimationFrame(tick);
  });
  const on = await run(false), off = await run(true);
  hs.forEach(h => h.layers.set(0));
  const med = (a, k) => { const s = a.map(r=>r[k]).sort((x,y)=>x-y); return s[s.length>>1]; };
  const fps = (a) => { const d=[]; for(let i=1;i<a.length;i++) d.push(a[i].dt-a[i-1].dt);
    d.sort((x,y)=>x-y); return +(1000/d[d.length>>1]).toFixed(1); };
  return { hulls: hs.length, drawn: WALLY.debug.outline().hullsDrawn,
    callsOn: med(on,'c'), callsOff: med(off,'c'), dCalls: med(on,'c')-med(off,'c'),
    trisOn: med(on,'t'), trisOff: med(off,'t'), dTris: med(on,'t')-med(off,'t'),
    fpsOn: fps(on), fpsOff: fps(off) };
});
console.log('inkCost', JSON.stringify(out.inkCost));
const perf = await page.evaluate(() => window.__WALLY_PERF__);
await close();
await writeFile(join(ROOT,'shots/j2/perf.json'), JSON.stringify({ out, perf, errors }, null, 1));
console.log(JSON.stringify({ perf, errors: errors.slice(0,5) }));
