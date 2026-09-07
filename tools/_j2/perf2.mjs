/* The local light's own cost: the shader branch is uniform, so a draw pays
   for all of it or none. Measured with the burner LIT against the same
   frame with the light forced black, at ground level in the city where the
   surface count is highest, and at night where it actually matters. */
import { boot, ROOT } from './lib.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:6000 });
await page.evaluate(() => {
  const info = WALLY.ctx.render?.renderer?.info || WALLY.ctx.renderer.info;
  window.__RUN = (ms) => new Promise(res => {
    const d = []; let last = performance.now(); const t0 = last; const c = []; const t = [];
    const tick = () => { const n = performance.now(); d.push(n-last); last = n;
      c.push(info.render.calls); t.push(info.render.triangles);
      if (n - t0 < ms) requestAnimationFrame(tick);
      else { const s = d.slice(5).sort((a,b)=>a-b), cs = c.slice(5).sort((a,b)=>a-b), ts = t.slice(5).sort((a,b)=>a-b);
        res({ n:s.length, fps:+(1000/s[s.length>>1]).toFixed(1), msP50:+s[s.length>>1].toFixed(2),
          msP95:+s[Math.floor(s.length*0.95)].toFixed(2), calls:cs[cs.length>>1], tris:ts[ts.length>>1],
          localCol: WALLY.ctx.mat.globals.uLocalCol.value.toArray().map(v=>+v.toFixed(3)) }); }
    };
    requestAnimationFrame(tick);
  });
});
const out = {};
for (const [name, hour] of [['day13', 13], ['night22', 22]]) {
  await page.evaluate((h) => { WALLY.debug.setHour(h); WALLY.debug.balloon(false); }, hour);
  await page.waitForTimeout(4000);
  out[name + '-noballoon'] = await page.evaluate(() => window.__RUN(4000));
  /* board on the ground, burner held on — the light is live and close to
     the whole town */
  await page.evaluate(() => { WALLY.debug.balloon({ alt: 4 }); WALLY.debug.balloonStick(0,0); WALLY.debug.balloonBurn(true); });
  await page.waitForTimeout(4000);
  out[name + '-lit'] = await page.evaluate(() => window.__RUN(4000));
  /* the same frame with the one light forced OUT, so the delta is the
     light and nothing else */
  await page.evaluate(() => { const g = WALLY.ctx.mat.globals;
    const c = g.uLocalCol.value; const set = c.setRGB.bind(c);
    c.setRGB = () => c; set(0,0,0); window.__UNPIN = () => { c.setRGB = set; }; });
  await page.waitForTimeout(2000);
  out[name + '-dark'] = await page.evaluate(() => window.__RUN(4000));
  await page.evaluate(() => window.__UNPIN());
  for (const k of [name+'-noballoon', name+'-lit', name+'-dark']) console.log(k, JSON.stringify(out[k]));
}
await close();
await writeFile(join(ROOT,'shots/j2/perf2.json'), JSON.stringify({out,errors},null,1));
console.log(JSON.stringify({ errors: errors.slice(0,4) }));
