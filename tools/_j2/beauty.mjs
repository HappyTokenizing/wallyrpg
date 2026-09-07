/* BEAUTY. The night burner shot, judged as art. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = join(ROOT, 'shots/j2/beauty');
await mkdir(OUT, { recursive: true });
const { page, errors, close } = await boot({ query: 'skipIntro&shot=1',
  viewport: { width: 1600, height: 900 }, settle: 4500 });

/* find a high ridge to put behind the machine */
const survey = await page.evaluate(() => {
  const out = [];
  for (let x = -600; x <= 600; x += 60)
    for (let z = -600; z <= 600; z += 60) {
      const h = WALLY.debug.worldHeight(x, z);
      if (h.shore > 20) out.push({ x, z, y: h.y, zone: h.zone });
    }
  out.sort((a,b)=>b.y-a.y);
  return { high: out.slice(0,8), n: out.length };
});
console.log('SURVEY', JSON.stringify(survey.high));

await page.evaluate(() => { WALLY.debug.camFree(); WALLY.ctx.wind.setStrength(0.12); });

const shot = async (name, setup, arg) => {
  await page.evaluate(setup, arg);
  await page.evaluate(() => new Promise(r => { let i=0; const t=()=>{ window.__PIN&&window.__PIN(); if(++i>=40) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }));
  const p = join(OUT, name + '.png');
  await page.screenshot({ path: p, animations: 'allow', timeout: 40000 });
  return p;
};

const CFG = JSON.parse(process.env.J2CFG || '{}');
const shots = [];

/* 1 — NIGHT over the city, the machine climbing out */
for (const [name, hour, alt, burn, cam] of [
  ['night-city',   22, 55, true,  { r: 26, h: 3.0, look: 6.0 }],
  ['night-city-off',22,55, false, { r: 26, h: 3.0, look: 6.0 }],
  ['dusk-city',    19.3, 55, true, { r: 26, h: 3.0, look: 6.0 }],
  ['night-low',    22, 14, true,  { r: 19, h: -2.0, look: 7.0 }],
  ['dusk-low',     19.0, 14, true,  { r: 19, h: -2.0, look: 7.0 }],
]) {
  shots.push(await shot(name, ({ hour, alt, burn, cam }) => {
    WALLY.debug.setHour(hour);
    WALLY.debug.balloon({ alt });
    WALLY.debug.balloonStick(0,0);
    WALLY.debug.balloonBurn(burn);
    const w = WALLY.ctx.wally.position.clone();
    window.__PIN = () => {
      WALLY.ctx.wally.position.copy(w);
      const c = WALLY.ctx.camera;
      c.position.set(w.x + cam.r*0.72, w.y + cam.h, w.z + cam.r*0.69);
      c.lookAt(w.x, w.y + cam.look, w.z);
      c.updateMatrixWorld(true);
    };
  }, { hour, alt, burn, cam }));
}

/* 2 — AGAINST A DARK HILLSIDE: put the machine low in front of the highest
   ridge the survey found and look at it with the hill filling the frame. */
const ridge = survey.high[0];
for (const [name, hour] of [['hill-night', 22], ['hill-dusk', 19.2]]) {
  shots.push(await shot(name, ({ ridge, hour }) => {
    WALLY.debug.setHour(hour);
    const gy = WALLY.debug.worldHeight(ridge.x, ridge.z).y;
    /* stand off from the ridge, downhill, so the hill is the backdrop */
    const ang = Math.atan2(ridge.x, ridge.z);
    const bx = ridge.x - Math.sin(ang) * 95, bz = ridge.z - Math.cos(ang) * 95;
    const by = WALLY.debug.worldHeight(bx, bz).y;
    WALLY.debug.balloon({ at: [bx, by + 22, bz], instant: true });
    WALLY.debug.balloonStick(0,0);
    WALLY.debug.balloonBurn(true);
    const w = WALLY.ctx.wally.position.clone();
    window.__PIN = () => {
      WALLY.ctx.wally.position.copy(w);
      const c = WALLY.ctx.camera;
      c.position.set(w.x - Math.sin(ang)*34, w.y + 1.0, w.z - Math.cos(ang)*34);
      c.lookAt(w.x, w.y + 6.0, w.z);
      c.updateMatrixWorld(true);
    };
  }, { ridge, hour }));
}
await close();
console.log(JSON.stringify({ shots: shots.map(s=>s.split('/').pop()), errors: errors.slice(0,5) }));
