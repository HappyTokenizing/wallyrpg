/* BEAUTY, second pass: the machine against a DARK HILLSIDE — no sky
   behind it, so the burner has to carry the read on its own. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
const OUT = join(ROOT, 'shots/j2/beauty');
await mkdir(OUT, { recursive: true });
const { page, errors, close } = await boot({ query: 'skipIntro&shot=1',
  viewport: { width: 1600, height: 900 }, settle: 4500 });

/* find the steepest long rise: a low point with a much higher point
   ~150 m away, so a camera on the low side sees hill and nothing else */
const site = await page.evaluate(() => {
  const H = (x,z) => WALLY.debug.worldHeight(x,z);
  let best = null;
  for (let x=-600; x<=600; x+=25) for (let z=-600; z<=600; z+=25) {
    const a = H(x,z); if (a.shore < 12) continue;
    for (const [dx,dz] of [[1,0],[0,1],[-1,0],[0,-1],[0.7,0.7],[-0.7,0.7],[0.7,-0.7],[-0.7,-0.7]]) {
      const b = H(x+dx*150, z+dz*150);
      const rise = b.y - a.y;
      if (rise > 30 && (!best || rise > best.rise))
        best = { x, z, y:a.y, hx:x+dx*150, hz:z+dz*150, hy:b.y, rise, dx, dz };
    }
  }
  return best;
});
console.log('SITE', JSON.stringify(site));

const shot = async (name, fn, arg) => {
  await page.evaluate(fn, arg);
  await page.evaluate(() => new Promise(r => { let i=0; const t=()=>{ window.__PIN&&window.__PIN(); if(++i>=45) r(); else requestAnimationFrame(t);} ; requestAnimationFrame(t); }));
  await page.screenshot({ path: join(OUT, name+'.png'), animations:'allow', timeout:40000 });
};

await page.evaluate(() => { WALLY.debug.camFree(); WALLY.ctx.wind.setStrength(0.10); });
for (const [name, hour, burn] of [['hillside-night', 22, true], ['hillside-night-off', 22, false],
                                  ['hillside-dusk', 19.4, true], ['hillside-dawn', 5.6, true]]) {
  await shot(name, ({ site, hour, burn }) => {
    WALLY.debug.setHour(hour);
    /* the balloon 55 m up the slope from the low point, low over the ground;
       the lens at the low point, level, so the hill fills the frame behind it */
    const bx = site.x + site.dx*58, bz = site.z + site.dz*58;
    const gy = WALLY.debug.worldHeight(bx,bz).y;
    WALLY.debug.balloon({ at: [bx, gy + 12, bz], instant: true });
    WALLY.debug.balloonStick(0,0);
    WALLY.debug.balloonBurn(burn);
    const w = WALLY.ctx.wally.position.clone();
    const cy = WALLY.debug.worldHeight(site.x, site.z).y;
    window.__PIN = () => {
      WALLY.ctx.wally.position.copy(w);
      const c = WALLY.ctx.camera;
      c.position.set(site.x, cy + 16, site.z);
      c.lookAt(w.x, w.y + 6.4, w.z);
      c.updateMatrixWorld(true);
    };
  }, { site, hour, burn });
}
await close();
console.log(JSON.stringify({ errors: errors.slice(0,5) }));
