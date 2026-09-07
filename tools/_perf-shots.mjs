/* _perf-shots.mjs — many framings, one boot. Art review for the
   quality pass. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const argv = process.argv.slice(2);
const W = +(argv.find(a => a.startsWith('--w='))?.slice(4) ?? 1600);
const H = +(argv.find(a => a.startsWith('--h='))?.slice(4) ?? 900);
const PRE = argv.find(a => a.startsWith('--prefix='))?.slice(9) ?? 'shots/qp/a';
const ONLY = argv.find(a => a.startsWith('--only='))?.slice(7) ?? null;
const logs = [];
const { page, close } = await boot({ w: W, h: H, logs });
await mkdir('shots/qp', { recursive: true }).catch(() => {});

const warp = (l) => page.evaluate((ll) => { const d = window.WALLY.debug;
  d.releaseCamera && d.releaseCamera(); d.arrive(ll, true); d.arriveNow && d.arriveNow();
  const p = window.WALLY.ctx.wally.position || window.WALLY.ctx.wally.root?.position;
  return p ? [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] : null; }, l);
const here = () => page.evaluate(() => { const p = window.WALLY.ctx.wally.position || window.WALLY.ctx.wally.root.position;
  return [p.x, p.y, p.z]; });

const SHOTS = {
  /* the load the player is in most: gameplay boom, busy street, day */
  street:    async () => { await warp('cafe'); },
  streetDusk:async () => { await warp('cafe'); await page.evaluate(() => WALLY.debug.setHour(19.2)); },
  streetNight:async()=> { await warp('cafe'); await page.evaluate(() => WALLY.debug.setHour(22)); },
  /* grass at a grazing angle */
  grassGraze:async () => { await warp('farmcoop');
    await page.evaluate(() => { const c = WALLY.ctx, Z = c.world.zones.greenedge;
      const y = WALLY.debug.worldHeight(Z.world.x, Z.world.z).y;
      WALLY.debug.lookAt(Z.world.x, y + 0.35, Z.world.z, { dist: 9, az: 40, el: 2.0, fov: 46 }); }); },
  /* sky + water at the horizon */
  horizon:   async () => { await page.evaluate(() => WALLY.debug.vista(200, 620, 42)); },
  /* outline width at distance: a long street run */
  farOutline:async () => { await warp('cafe'); const p = await here();
    await page.evaluate((q) => WALLY.debug.lookAt(q[0], q[1] + 6, q[2], { dist: 120, az: 30, el: 9, fov: 34 }), p); },
  /* contact shadows where things meet the ground */
  contact:   async () => { await warp('markethall'); const p = await here();
    await page.evaluate((q) => WALLY.debug.lookAt(q[0], q[1] + 0.5, q[2], { dist: 7, az: 25, el: 10, fov: 40 }), p); },
  /* large flat surfaces: banding hunt, sky gradient */
  skyBand:   async () => { await page.evaluate(() => { WALLY.debug.setHour(17.4); WALLY.debug.vista(160, 700, 120); }); },
  /* the balloon envelope — the two-band terminator regression check */
  balloonA:  async () => { await page.evaluate(() => { WALLY.debug.setHour(12);
    WALLY.debug.balloon({ alt: 60 }); }); await page.waitForTimeout(1200);
    await page.evaluate(() => { const i = WALLY.debug.balloonInfo();
      WALLY.debug.lookAt(i.pos ? i.pos[0] : 0, (i.pos ? i.pos[1] : 60) + 6, i.pos ? i.pos[2] : 0, { dist: 22, az: 30, el: 6, fov: 40 }); }); },
  balloonB:  async () => { await page.evaluate(() => { WALLY.debug.setHour(8); });
    await page.waitForTimeout(600);
    await page.evaluate(() => { const i = WALLY.debug.balloonInfo();
      WALLY.debug.lookAt(i.pos ? i.pos[0] : 0, (i.pos ? i.pos[1] : 60) + 6, i.pos ? i.pos[2] : 0, { dist: 22, az: 210, el: 6, fov: 40 }); }); },
};
const HOUR = { streetDusk: 19.2, streetNight: 22, skyBand: 17.4 };
for (const [k, fn] of Object.entries(SHOTS)) {
  if (ONLY && !ONLY.split(',').includes(k)) continue;
  /* THE HOUR DOES NOT RESET ITSELF. Left alone, every shot after the
     night one is a night shot and the day sweep measures nothing. */
  await page.evaluate((h) => WALLY.debug.setHour(h), HOUR[k] ?? 12.5);
  await fn().catch(e => console.log(`${k}: ${e.message}`));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${PRE}-${k}.png`, animations: 'allow' });
  const p = await page.evaluate(() => window.__WALLY_PERF__);
  console.log(`${k}  ${PRE}-${k}.png  fps ${p?.fps} calls ${p?.calls} tris ${p?.tris}`);
}
const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
if (errs.length) console.log('ERRORS\n' + errs.slice(0, 6).join('\n'));
await close();
