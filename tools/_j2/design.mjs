/* DESIGN. (a) cruise speed dead upwind against dead downwind, measured on
   the machine's own position over a long steady run, not on the model.
   (b) can it be landed on a roof? */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT, 'shots/j2/design'); await mkdir(OUT, { recursive:true });
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1280, height:720 }, settle:5000 });

/* ---------- (a) upwind vs downwind ---------- */
const wind = await page.evaluate(() => {
  /* a steady air, so the answer is about the machine and not about a gust.
     0.316 is FLIGHT.windNom — the measured mean of the live field. */
  const w = WALLY.ctx.wind, T = WALLY.THREE;
  const NOM = 0.316, dirx = 1, dirz = 0;
  const V = { x: NOM*dirx, y:0, z: NOM*dirz };
  w.vector = (x,z,out) => out ? out.set(V.x,0,V.z) : V;
  w.setStrength(NOM);
  return { nom: NOM, dir: [dirx, dirz] };
});
const runLeg = async (sx, sz, label) => {
  await page.evaluate(({sx,sz}) => {
    WALLY.debug.balloon(false);
    WALLY.debug.balloon({ alt: 120 });
    WALLY.debug.balloonStick(sx, sz);
    /* HOLD THE BURNER. With it off the machine cools, sinks, and the last
       seconds of the run are flyCollide() scrubbing the velocity against a
       hill — which is a measurement of the terrain, not of the air. */
    WALLY.debug.balloonBurn(true);
  }, {sx,sz});
  await page.waitForTimeout(50000);            // let the 4.5 s lag settle out, hard
  const r = await page.evaluate(() => new Promise(res => {
    const w = WALLY.ctx.wally, t0 = performance.now();
    const p0 = w.position.clone(); const rows = [];
    const tick = () => { const t = performance.now();
      let bi = {}; try { bi = WALLY.debug.balloonInfo(); } catch(e){}
      rows.push({ ms: t - t0, x: w.position.x, z: w.position.z, drift: bi.drift, alt: bi.alt });
      if (t - t0 < 12000) requestAnimationFrame(tick);
      else { const a = rows[0], b = rows[rows.length-1];
        const dist = Math.hypot(b.x-a.x, b.z-a.z), dt = (b.ms-a.ms)/1000;
        const ds = rows.map(r=>r.drift).filter(Number.isFinite).sort((x,y)=>x-y);
        res({ groundSpeed: +(dist/dt).toFixed(3), secs: +dt.toFixed(1),
          driftP50: +ds[ds.length>>1].toFixed(3), driftMin: +ds[0].toFixed(3), driftMax: +ds[ds.length-1].toFixed(3),
          alt: +rows[rows.length-1].alt.toFixed(1),
          heading: +(Math.atan2(b.x-a.x, b.z-a.z)*57.29578).toFixed(1) });
      } };
    requestAnimationFrame(tick);
  }));
  console.log(label, JSON.stringify(r));
  return { label, stick:[sx,sz], ...r };
};
const legs = [];
legs.push(await runLeg( 1, 0, 'downwind (stick +x, air +x)'));
legs.push(await runLeg(-1, 0, 'upwind   (stick -x, air +x)'));
legs.push(await runLeg( 0, 1, 'crosswind(stick +z)'));
legs.push(await runLeg( 0, 0, 'drift only (no stick)'));

/* ---------- (b) the roof ---------- */
const roof = await page.evaluate(async () => {
  /* find a flat roof big enough to stand a basket on: a building whose
     collision top is level over a 6 m disc, well above the ground */
  const W = WALLY.ctx.world, phys = WALLY.ctx.physics || WALLY.ctx.phys;
  const hits = [];
  const probe = (x,z) => {
    const r = WALLY.debug.cliffProbe ? null : null;
    return null;
  };
  return null;
});
await page.evaluate(() => { WALLY.debug.balloonStick(0,0); });
await close();
await writeFile(join(OUT,'legs.json'), JSON.stringify({ wind, legs, errors }, null, 1));
console.log(JSON.stringify({ wind, errors: errors.slice(0,4) }));
