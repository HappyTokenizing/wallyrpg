/* Two last looks: the container yard (are the deeply bedded boxes visible?)
   and a night take-off (does the burner reach the grass?). */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
const OUT = join(ROOT,'shots/j2/final'); await mkdir(OUT,{recursive:true});
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:5500 });
const shot = async (n, fn, arg) => { await page.evaluate(fn, arg);
  await page.evaluate(()=>new Promise(r=>{let i=0;const t=()=>{window.__PIN&&window.__PIN(); if(++i>=45)r(); else requestAnimationFrame(t);};requestAnimationFrame(t);}));
  await page.screenshot({ path: join(OUT,n+'.png'), animations:'allow', timeout:40000 }); };

await page.evaluate(() => { WALLY.debug.camFree(); WALLY.ctx.wind.setStrength(0.14); });
/* the yard, from the landward side, at noon */
await shot('yard', () => {
  WALLY.debug.setHour(13); WALLY.debug.balloon(false);
  const c = WALLY.ctx.camera;
  window.__PIN = () => { c.position.set(-135, 16, 205); c.lookAt(-95, 3, 228); c.updateMatrixWorld(true); };
});
await shot('yard2', () => {
  const c = WALLY.ctx.camera;
  window.__PIN = () => { c.position.set(-118, 8, 250); c.lookAt(-100, 3, 230); c.updateMatrixWorld(true); };
});
/* a night take-off: on the grass, burner lit, envelope up */
await shot('night-takeoff', () => {
  WALLY.debug.setHour(22);
  WALLY.debug.balloon({ alt: 1.2 });
  WALLY.debug.balloonStick(0,0); WALLY.debug.balloonBurn(true);
  const w = WALLY.ctx.wally.position.clone(), c = WALLY.ctx.camera;
  window.__PIN = () => { WALLY.ctx.wally.position.copy(w);
    c.position.set(w.x + 13, w.y + 2.4, w.z + 13); c.lookAt(w.x, w.y + 4.5, w.z); c.updateMatrixWorld(true); };
});
await shot('night-takeoff-off', () => { WALLY.debug.balloonBurn(false); });
await close();
console.log(JSON.stringify({ errors: errors.slice(0,4) }));
