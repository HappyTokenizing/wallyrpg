/* THE OCEAN. Open water, four independent frames, on the ground and at
   altitude. Horizontal striping is measured DOWN each column of a patch
   of pure sea: the profile is detrended against a 21-row moving mean and
   then (a) gradient sign reversals per row and (b) the detrended
   peak-to-trough in 8-bit codes are taken. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT, 'shots/j2/sea');
await mkdir(OUT, { recursive: true });
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:5000 });
await page.evaluate(() => {
  WALLY.debug.setHour(13); WALLY.ctx.wind.setStrength(0.30);
  /* find a beach: land within 6 m of the waterline, with open sea beyond */
  let best = null;
  for (let x=-620;x<=620;x+=20) for (let z=-620;z<=620;z+=20) {
    const h = WALLY.debug.worldHeight(x,z);
    if (h.y < 0.4 || h.y > 4 || h.shore > 8) continue;
    let open = 0;
    for (let r=200;r<=800;r+=100) { const g = WALLY.debug.worldHeight(x*(1+r/Math.max(1,Math.hypot(x,z))), z*(1+r/Math.max(1,Math.hypot(x,z)))); if (g.y < 0.2) open++; }
    if (!best || open > best.open) best = { x, z, y:h.y, open };
  }
  window.__SHORE = best;
  return best;
});

const pump = (n=40) => page.evaluate(k => new Promise(r => {
  let i=0; const t=()=>{ window.__PIN&&window.__PIN(); if(++i>=k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), n);

const rows = [];
for (const [name, alt] of [['ground', 0], ['alt200', 200], ['alt120', 120]]) {
  const info = await page.evaluate((a) => {
    WALLY.debug.balloon(false);
    /* PUT HIM ON THE SHORE. The reference for the sea is the sea as it
       is authored to be seen: from the beach, at head height. */
    if (window.__SHORE) { const s = window.__SHORE; WALLY.debug.wallyWarp(s.x, undefined, s.z); }
    if (a > 0) { WALLY.debug.balloon({ alt: a }); WALLY.debug.balloonStick(0,0); }
    WALLY.debug.camFree();
    const w = WALLY.ctx.wally.position.clone();
    /* AIM AT WATER. Away from the island centre, at a point on the sea
       surface far enough out that the patch under the horizon is all sea. */
    /* pick the bearing with the most open water in front of it */
    let dx = 1, dz = 0, best = -1;
    for (let k = 0; k < 36; k++) {
      const th = k * Math.PI / 18, sx = Math.sin(th), sz = Math.cos(th);
      let ok = 0;
      for (let r = 300; r <= 900; r += 60) {
        const h = WALLY.debug.worldHeight(w.x + sx*r, w.z + sz*r);
        if (h.y < 0.2) ok++;
      }
      if (ok > best) { best = ok; dx = sx; dz = sz; }
    }
    window.__PIN = () => {
      const c = WALLY.ctx.camera;
      c.position.set(w.x, w.y + 2.0, w.z);
      c.lookAt(w.x + dx * 700, 0, w.z + dz * 700);
      c.updateMatrixWorld(true);
      c.fov = 55; c.updateProjectionMatrix();
    };
    window.__PIN();
    let fades = null;
    WALLY.ctx.scene.traverse(o => { if (o.material?.uniforms?.uWaveFade)
      fades = o.material.uniforms.uWaveFade.value.map(v => [+v.x.toFixed(1), +v.y.toFixed(1)]); });
    return { at: [+w.x.toFixed(1), +w.y.toFixed(1), +w.z.toFixed(1)], dir: [+dx.toFixed(3), +dz.toFixed(3)],
      fog: +(WALLY.ctx.scene.fog?.far ?? 0).toFixed(0), fades };
  }, alt);
  for (let i=0;i<4;i++) {
    await pump(45);
    const p = join(OUT, `${name}_f${i}.png`);
    await page.screenshot({ path:p, animations:'allow', timeout:40000 });
    rows.push({ name, alt, i, p, ...info });
  }
  console.log(name, JSON.stringify(info));
}
await close();
await writeFile(join(OUT,'index.json'), JSON.stringify(rows, null, 1));
console.log(JSON.stringify({ errors: errors.slice(0,4) }));
