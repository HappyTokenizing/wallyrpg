/* TEXTURING. The envelope's shading, at every sun bearing, burner on and off.
   The mask is exact: one frame with the envelope drawn, one with it hidden,
   differenced — so nothing but the fabric is measured. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const HOURS = (process.argv[2] || '7,10,13,16,19,22').split(',').map(Number);
const AZIS  = (process.argv[3] || '0,45,90,135,180,225,270,315').split(',').map(Number);
const BURN  = process.argv.includes('--burn');
const KEEP  = process.argv.includes('--keep');

const OUT = join(ROOT, 'shots/j2/tex');
await mkdir(OUT, { recursive: true });
const { page, errors, close } = await boot({ query: 'skipIntro&shot=1',
  viewport: { width: 1000, height: 1000 }, settle: 4500 });

await page.evaluate(() => {
  WALLY.debug.balloon({ alt: 90 });
  WALLY.debug.balloonStick(0, 0);
  WALLY.debug.camFree();
  WALLY.ctx.wind.setStrength(0.10);
  window.__ENV = null; window.__TAPE = null;
  WALLY.ctx.scene.traverse(o => {
    if (o.name === 'balloon.envelope') window.__ENV = o;
    if (o.name === 'balloon.tapes') window.__TAPE = o;
  });
  window.__HULLS = [];
  WALLY.ctx.scene.traverse(o => { if (o.userData && o.userData.isOutlineHull) window.__HULLS.push(o); });
  /* pin the machine and the lens: the shot must be the same shot every time */
  const w = WALLY.ctx.wally.position.clone();
  window.__W = w;
  window.__PIN = (azDeg) => {
    const a = azDeg * Math.PI / 180, R = 17;
    const cam = WALLY.ctx.camera;
    WALLY.ctx.wally.position.copy(w);
    cam.position.set(w.x + Math.sin(a) * R, w.y + 4.2, w.z + Math.cos(a) * R);
    cam.lookAt(w.x, w.y + 6.2, w.z);
    cam.updateMatrixWorld(true);
  };
  return true;
});

const pump = (n = 22) => page.evaluate((k) => new Promise(r => {
  let i = 0; const t = () => { window.__PIN(window.__AZ || 0); if (++i >= k) r(); else requestAnimationFrame(t); };
  requestAnimationFrame(t);
}), n);

const rows = [];
for (const h of HOURS) {
  await page.evaluate((hh) => { WALLY.debug.setHour(hh); }, h);
  for (const az of AZIS) {
    await page.evaluate((a) => { window.__AZ = a; }, az);
    await page.evaluate((b) => { WALLY.debug.balloonBurn(b); }, BURN);
    await pump(26);
    const tag = `h${h}_a${az}${BURN ? '_burn' : ''}`;
    const on = join(OUT, tag + '.png');
    await page.screenshot({ path: on, animations: 'allow', timeout: 30000 });
    /* hide the fabric (and its ink) for the mask */
    await page.evaluate(() => { window.__ENV.visible = false; window.__TAPE.visible = false;
      window.__HULLS.forEach(o => { o.userData.__wv = o.visible; o.visible = false; }); });
    await pump(3);
    const off = join(OUT, tag + '_off.png');
    await page.screenshot({ path: off, animations: 'allow', timeout: 30000 });
    await page.evaluate(() => { window.__ENV.visible = true; window.__TAPE.visible = true;
      window.__HULLS.forEach(o => { o.visible = o.userData.__wv !== false; }); });
    const sun = await page.evaluate(() => {
      const g = WALLY.ctx.mat?.globals || {};
      return { sunI: +(g.uSunIntensity?.value ?? -1).toFixed(3),
               sunDir: g.uSunDir ? [+g.uSunDir.value.x.toFixed(3), +g.uSunDir.value.y.toFixed(3), +g.uSunDir.value.z.toFixed(3)] : null,
               localCol: g.uLocalCol ? [+g.uLocalCol.value.r.toFixed(3), +g.uLocalCol.value.g.toFixed(3), +g.uLocalCol.value.b.toFixed(3)] : null };
    });
    rows.push({ h, az, tag, on, off, ...sun });
  }
}
await close();
await writeFile(join(OUT, (BURN?'burn':'plain')+'-index.json'), JSON.stringify(rows, null, 1));
console.log(JSON.stringify({ n: rows.length, errors: errors.slice(0,5) }));
