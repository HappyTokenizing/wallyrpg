/* DESIGN, part 2. Can it be landed on a roof — and is the sea refused?
   No teleporting onto the roof: it is FLOWN down onto one and the dismount
   is asked for the same way a player asks for it. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT,'shots/j2/design'); await mkdir(OUT,{recursive:true});
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1280, height:720 }, settle:5500 });

await page.evaluate(() => {
  WALLY.debug.setHour(13);
  const w = WALLY.ctx.wind; const Z = {x:0,y:0,z:0};
  w.vector = (x,z,out) => out ? out.set(0,0,0) : Z;   // dead calm: aim, don't chase
  w.setStrength(0);
});

/* find a tall flat roof by raycasting the collision world straight down */
const roofs = await page.evaluate(() => {
  const list = WALLY.debug.cityList();
  const out = [];
  const probe = (x, z) => {
    const h = WALLY.debug.worldHeight(x, z);
    return h;
  };
  /* the balloon's own surface probe is the honest one: it is what the
     flight uses to decide what is under it. Reach it through a boarded
     machine's info. */
  return { n: list.length, sample: list.slice(0, 6) };
});
console.log('CITY', JSON.stringify(roofs));

/* Walk a grid with the flight's own "what is under me" solve by parking the
   balloon high above each candidate and reading balloonInfo().ground. */
const cands = await page.evaluate(async () => {
  WALLY.debug.balloon({ alt: 200 });
  WALLY.debug.balloonStick(0,0);
  const out = [];
  const at = (x,z) => new Promise(r => { WALLY.debug.balloon({ at:[x, 300, z] });
    requestAnimationFrame(()=>requestAnimationFrame(()=>{ let i={}; try{i=WALLY.debug.balloonInfo();}catch(e){}
      r({ x, z, ground: i.ground, alt: i.alt, over: i.overWater }); })); });
  for (let x=-560; x<=560; x+=8) for (let z=-560; z<=560; z+=8) {
    const t = WALLY.debug.worldHeight(x,z);
    out.push({ x, z, terrain: +t.y.toFixed(2) });
  }
  return out.length;
});

/* simpler and truthful: use the flight's own probe, one point at a time,
   over the buildings the city knows about */
const found = await page.evaluate(async () => {
  const step = () => new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)));
  const res = [];
  const ids = WALLY.debug.cityList();
  for (const rec of ids) {
    const p = WALLY.ctx.game?.actions?.parkSpot ? null : null;
  }
  /* sweep a coarse grid and keep the points where the flight's ground solve
     is well ABOVE the terrain — that is a roof under the machine */
  for (let x=-460; x<=460; x+=4) {
    for (let z=-460; z<=460; z+=4) {
      const t = WALLY.debug.worldHeight(x,z).y;
      if (t < 2) continue;                     // LAND only — the seabed is not a roof
      WALLY.debug.balloon({ at:[x, t + 120, z] });
      await step();
      let i={}; try{i=WALLY.debug.balloonInfo();}catch(e){}
      if (i.overWater) continue;
      if (Number.isFinite(i.ground) && i.ground - t > 4.0) res.push({ x, z, terrain:+t.toFixed(2), roof:+i.ground.toFixed(2), h:+(i.ground-t).toFixed(2) });
      if (res.length > 120) break;
    }
    if (res.length > 120) break;
  }
  return res;
});
console.log('ROOF CANDIDATES', found.length, JSON.stringify(found.slice(0,6)));

/* pick one whose roof height is level over a 5 m square — a basket needs
   somewhere to stand, not a ridge */
const flat = [];
for (const c of found) {
  const ok = await page.evaluate(async (c) => {
    const step = () => new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)));
    let lo = Infinity, hi = -Infinity;
    for (const [dx,dz] of [[0,0],[2.5,0],[-2.5,0],[0,2.5],[0,-2.5],[2.5,2.5],[-2.5,-2.5]]) {
      WALLY.debug.balloon({ at:[c.x+dx, c.roof + 90, c.z+dz] });
      await step();
      let i={}; try{i=WALLY.debug.balloonInfo();}catch(e){}
      if (!Number.isFinite(i.ground)) return null;
      lo = Math.min(lo, i.ground); hi = Math.max(hi, i.ground);
    }
    return { spread: +(hi-lo).toFixed(3), lo:+lo.toFixed(2), hi:+hi.toFixed(2) };
  }, c);
  if (ok && ok.spread < 0.25) { flat.push({ ...c, ...ok }); if (flat.length >= 4) break; }
}
console.log('FLAT ROOFS', flat.length, JSON.stringify(flat.slice(0,4)));

/* ---- FLY ONE DOWN ONTO IT ---- */
const trials = [];
for (const c of flat.slice(0,3)) {
  const t = await page.evaluate(async (c) => {
    const step = () => new Promise(r => requestAnimationFrame(r));
    WALLY.debug.balloon({ at:[c.x, c.roof + 34, c.z] });
    WALLY.debug.balloonStick(0,0);
    WALLY.debug.balloonBurn(false);
    const trace = [];
    for (let f = 0; f < 1500; f++) {
      await step();
      let i={}; try{i=WALLY.debug.balloonInfo();}catch(e){}
      if (f % 20 === 0) trace.push({ f, alt:+(i.alt??-1).toFixed(2), y:+WALLY.ctx.wally.position.y.toFixed(2),
        ground:+(i.ground??-1).toFixed(2), refusing:i.refusing, phase:i.phase, vy:+(i.vy??0).toFixed(3) });
      if (i.alt != null && i.alt < 0.30 && Math.abs(i.vy ?? 0) < 0.05) break;
    }
    /* now ask to get out, the way a player does */
    let info={}; try{info=WALLY.debug.balloonInfo();}catch(e){}
    WALLY.ctx.game.actions.equipRide(null);
    for (let f=0; f<420; f++) await step();
    const w = WALLY.ctx.wally.position;
    return { roof:c, trace: trace.slice(-8), settled: info,
      standingAt: [+w.x.toFixed(2), +w.y.toFixed(2), +w.z.toFixed(2)],
      terrain: c.terrain, onRoof: (w.y - c.terrain) > 4.5 };
  }, c);
  trials.push(t);
  console.log('ROOF TRIAL', JSON.stringify({ roof:[t.roof.x,t.roof.z,t.roof.roof], standingAt:t.standingAt, onRoof:t.onRoof, terrain:t.terrain }));
  await page.screenshot({ path: join(OUT, `roof_${t.roof.x}_${t.roof.z}.png`), animations:'allow', timeout:30000 });
}

/* ---- AND THE SEA, for the comparison the brief asks for ---- */
const seaTrial = await page.evaluate(async () => {
  const step = () => new Promise(r => requestAnimationFrame(r));
  /* somewhere with only water under it */
  let sx=0, sz=0;
  for (let r=300; r<=900; r+=20) { const h=WALLY.debug.worldHeight(-r, -r); if (h.y < 0.05) { sx=-r; sz=-r; break; } }
  WALLY.debug.balloon({ at:[sx, 60, sz] });
  WALLY.debug.balloonStick(0,0); WALLY.debug.balloonBurn(false);
  const tr=[];
  for (let f=0; f<3200; f++) { await step();
    let i={}; try{i=WALLY.debug.balloonInfo();}catch(e){}
    if (f%200===0) tr.push({f, alt:+(i.alt??-1).toFixed(2), refusing:i.refusing, phase:i.phase, vy:+(i.vy??0).toFixed(2)}); }
  let i={}; try{i=WALLY.debug.balloonInfo();}catch(e){}
  /* and ask to get out over the sea */
  WALLY.ctx.game.actions.equipRide(null);
  for (let f=0;f<300;f++) await step();
  let j={}; try{j=WALLY.debug.balloonInfo();}catch(e){}
  const w=WALLY.ctx.wally.position;
  return { at:[sx,sz], trace:tr, afterDescent:{alt:+(i.alt??-1).toFixed(2), refusing:i.refusing, phase:i.phase},
    afterDismountAsk:{ phase:j.phase, alt:+(j.alt??-1).toFixed(2) }, wallyY:+w.y.toFixed(2) };
});
console.log('SEA', JSON.stringify(seaTrial));
await close();
await writeFile(join(OUT,'roof.json'), JSON.stringify({ flat, trials, seaTrial, errors }, null, 1));
