/* SEAMLESSNESS. Worst look-direction change per frame across a boarding
   and a dismount, BECALMED and DRIFTING. My own sampler, end-of-frame. */
import { boot, ROOT, d2 } from './lib.mjs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const MODE = process.argv[2] || 'becalmed';   // becalmed | drifting
const REP  = Number(process.argv[3] || 0);
const FILM = process.argv.includes('--film');

const { page, errors, close } = await boot({ settle: 4500 });

/* ---- force the air ---- */
await page.evaluate((mode) => {
  const w = WALLY.ctx.wind;
  if (mode === 'becalmed') {
    w.setStrength(0);
    w.uniforms.uWindGust.value = 0;
    const zero = { x:0, y:0, z:0 };
    w.vector = (x, z, out) => out ? out.set(0,0,0) : zero;
    // hold the gust at zero every frame
    const up = w.update.bind(w);
    w.update = (dt, el) => { up(dt, el); w.uniforms.uWindStrength.value = 0; w.uniforms.uWindGust.value = 0; };
  } else if (mode === 'opposed') {
    /* the worst case for the align branch: the air runs exactly OPPOSITE
       to the lens's forward at the moment of boarding, so the corrective
       damp has a half turn to bring round. */
    w.setStrength(0.62);
    const T = WALLY.THREE, f = new T.Vector3();
    WALLY.ctx.camera.getWorldDirection(f);
    const m = 0.62;
    const V = { x: -f.x*m, y:0, z: -f.z*m };
    w.vector = (x, z, out) => out ? out.set(V.x,0,V.z) : V;
    window.__WINDV = V;
  } else {
    w.setStrength(0.62);
    const V = { x: 0.86*0.62, y:0, z: 0.51*0.62 };
    w.vector = (x, z, out) => out ? out.set(V.x,0,V.z) : V;
  }
}, MODE);

/* ---- end-of-frame sampler. The game books its next rAF at the TOP of
   its own callback, so a rAF registered from here always runs AFTER the
   full step + draw for that tick. ---- */
await page.evaluate(() => {
  window.__S = [];
  const c = WALLY.ctx.camera, T = WALLY.THREE;
  const f = new T.Vector3(), up = new T.Vector3(), rt = new T.Vector3();
  let last = null, t0 = performance.now();
  const tick = () => {
    const now = performance.now();
    c.getWorldDirection(f);
    up.set(0,1,0).applyQuaternion(c.quaternion);
    rt.set(1,0,0).applyQuaternion(c.quaternion);
    let dAng = 0, dUp = 0;
    if (last) {
      dAng = Math.acos(Math.max(-1, Math.min(1, f.x*last.fx + f.y*last.fy + f.z*last.fz))) * 57.29578;
      dUp  = Math.acos(Math.max(-1, Math.min(1, up.x*last.ux + up.y*last.uy + up.z*last.uz))) * 57.29578;
    }
    const bi = (()=>{ try { return WALLY.debug.balloonInfo(); } catch(e){ return {}; } })();
    const bc = (()=>{ try { return WALLY.debug.balloonCam(); } catch(e){ return {}; } })();
    const wp = WALLY.ctx.wally ? WALLY.ctx.wally.position : {x:0,y:0,z:0};
    const rec = {
      ms: +(now - t0).toFixed(1),
      dt: last ? +(now - last.now).toFixed(1) : 0,
      ph: bi.phase || '', mode: WALLY.ctx.cam?.mode || '',
      drift: bi.drift ?? null, alt: bi.alt ?? null,
      dAng: +dAng.toFixed(3), dUp: +dUp.toFixed(3),
      dps: last && (now-last.now)>0 ? +(dAng / ((now-last.now)/1000)).toFixed(1) : 0,
      pitch: +(Math.asin(Math.max(-1,Math.min(1,f.y)))*57.29578).toFixed(2),
      camY: +c.position.y.toFixed(3), fov: +c.fov.toFixed(2),
      dpos: last ? +Math.hypot(c.position.x-last.px, c.position.y-last.py, c.position.z-last.pz).toFixed(4) : 0,
      aimDist: bc.aimDist ?? null, behind: bc.behind ?? null,
      wy: +wp.y.toFixed(2),
    };
    window.__S.push(rec);
    last = { now, fx:f.x, fy:f.y, fz:f.z, ux:up.x, uy:up.y, uz:up.z, px:c.position.x, py:c.position.y, pz:c.position.z };
    if (window.__S.length < 6000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.waitForTimeout(800);
const mark = async (tag) => page.evaluate(t => { window.__S.push({ MARK: t, ms: -1 }); }, tag);

await mark('board');
await page.evaluate(() => { const g = WALLY.ctx.game; g.actions.grantRide('balloon'); g.actions.equipRide('balloon'); });

if (FILM) {
  await mkdir(join(ROOT, 'shots/j2/seam-'+MODE), { recursive: true });
  for (let i=0;i<20;i++){ await page.waitForTimeout(130);
    await page.screenshot({ path: join(ROOT,'shots/j2/seam-'+MODE,'b'+String(i).padStart(2,'0')+'.png'), animations:'allow', timeout:30000 }); }
} else await page.waitForTimeout(2600);

await page.waitForTimeout(9000);          // settle aloft
await mark('cruise');
await page.waitForTimeout(4000);
await mark('dismount');
await page.evaluate(() => { WALLY.ctx.game.actions.equipRide(null); });
await page.waitForTimeout(6000);
await mark('end');
await page.waitForTimeout(2500);

const S = await page.evaluate(() => window.__S);
await close();

/* ---- analysis ---- */
const marks = {}; let cur = 'pre';
const rows = [];
for (const r of S) { if (r.MARK) { marks[r.MARK] = rows.length; cur = r.MARK; continue; } r.seg = cur; rows.push(r); }

function worst(pred, label) {
  const cand = rows.filter(pred).filter(r => r.dt > 0 && r.dt < 200);
  if (!cand.length) return null;
  const w = cand.reduce((a,b)=> b.dAng > a.dAng ? b : a);
  const wr = cand.reduce((a,b)=> b.dps > a.dps ? b : a);
  const wp = cand.reduce((a,b)=> Math.abs(b.pitch) > Math.abs(a.pitch) ? b : a);
  const wd = cand.reduce((a,b)=> b.dpos > a.dpos ? b : a);
  const minAim = cand.filter(r=>r.aimDist!=null).reduce((a,b)=> (b.aimDist<a.aimDist?b:a), {aimDist:1e9});
  const minBehind = cand.filter(r=>r.behind!=null).reduce((a,b)=> (b.behind<a.behind?b:a), {behind:1e9});
  return { label, n:cand.length, worstDeg:w.dAng, worstDt:w.dt, worstAt:w.ms, worstPh:w.ph,
    worstDps:wr.dps, dpsDeg:wr.dAng, dpsDt:wr.dt, maxPitch:wp.pitch, worstStep:wd.dpos,
    minAimDist: minAim.aimDist===1e9?null:minAim.aimDist, minBehind: minBehind.behind===1e9?null:minBehind.behind };
}

const out = {
  mode: MODE, rep: REP, frames: rows.length,
  driftAtCruise: (()=>{const c=rows.filter(r=>r.seg==='cruise'&&r.drift!=null); return c.length? d2(c.reduce((a,b)=>a+b.drift,0)/c.length,3):null;})(),
  overall: worst(r=>true, 'all'),
  boarding: worst(r=>r.seg==='board', 'boarding'),
  cruise: worst(r=>r.seg==='cruise', 'cruise'),
  dismount: worst(r=>r.seg==='dismount', 'dismount'),
  errors: errors.slice(0,6),
};
console.log(JSON.stringify(out, null, 1));

/* the ten worst frames overall, with load */
const top = rows.filter(r=>r.dt>0&&r.dt<200).sort((a,b)=>b.dAng-a.dAng).slice(0,10);
console.log('\n  ms      seg        phase     mode      dAng   dt    deg/s   pitch  dpos  aimD  behind');
for (const r of top) console.log(
 `${String(r.ms).padStart(8)} ${String(r.seg).padEnd(9)} ${String(r.ph).padEnd(9)} ${String(r.mode).padEnd(9)} ${String(r.dAng).padStart(6)} ${String(r.dt).padStart(5)} ${String(r.dps).padStart(7)} ${String(r.pitch).padStart(6)} ${String(r.dpos).padStart(6)} ${String(r.aimDist).padStart(6)} ${String(r.behind).padStart(7)}`);
