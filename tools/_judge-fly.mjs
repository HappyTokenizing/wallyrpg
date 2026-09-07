#!/usr/bin/env node
/* JUDGE — SEAMLESSNESS. Mount, rise, cruise, descend, land, dismount,
   through the game's own ownership path (grantRide + equipRide), with a
   per-frame camera/subject tracker so a pop, snap or teleport is a number.
   Films the whole thing as a filmstrip. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'shots/judge/fly');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = createServer(async (rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:120000});
await page.waitForTimeout(4500);
await mkdir(OUT,{recursive:true});

/* ---- the tracker: camera + subject, every frame, for the whole run ---- */
await page.evaluate(() => {
  window.__TRK = [];
  const c = WALLY.ctx.camera, w = WALLY.ctx.wally;
  let last = performance.now(), lp = c.position.clone(), lq = c.quaternion.clone();
  let lw = w.position ? w.position.clone() : null;
  const tick = () => {
    const n = performance.now(), dt = (n-last)/1000; last = n;
    const dp = c.position.distanceTo(lp);
    let d = lq.x*c.quaternion.x + lq.y*c.quaternion.y + lq.z*c.quaternion.z + lq.w*c.quaternion.w;
    d = Math.min(1, Math.abs(d));
    const dq = 2*Math.acos(d)*57.2958;
    const wp = w.position ? w.position.clone() : null;
    const dw = (lw && wp) ? wp.distanceTo(lw) : 0;
    let fi = null; try { fi = WALLY.debug.balloonInfo(); } catch(e){}
    window.__TRK.push({ t:+(n/1000).toFixed(3), dt:+dt.toFixed(4),
      camMove:+dp.toFixed(4), camTurn:+dq.toFixed(3), fov:+c.fov.toFixed(2),
      subjMove:+dw.toFixed(4),
      camY:+c.position.y.toFixed(2), mode: WALLY.ctx.cam?.mode || '',
      phase: fi?fi.phase:'', alt: fi?+fi.alt.toFixed(2):0, vy: fi?+fi.vy.toFixed(2):0,
      inflate: fi?+fi.inflate.toFixed(3):0, blend: fi?+fi.blend.toFixed(3):0,
      refusing: fi?fi.refusing:false, y: fi?fi.at[1]:0, mark: window.__MARK||'' });
    lp.copy(c.position); lq.copy(c.quaternion); if (wp) lw = wp;
    if (window.__TRK.length < 40000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const mark = (m) => page.evaluate(s => { window.__MARK = s; }, m);
const shot = (n) => page.screenshot({ path: join(OUT, n+'.png'), timeout:30000 });
const wait = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);

/* ================= 1. OWN IT, THE GAME'S OWN WAY ================= */
const owned = await ev(() => {
  const g = WALLY.ctx.game;
  g.actions.grantRide('balloon');
  const r = g.actions.equipRide('balloon');
  return { r, rides: g.actions.rides().map(x=>`${x.id}${x.owned?'+':'-'}${x.equipped?'E':''}`).join(' ') };
});
console.log('OWNED', JSON.stringify(owned));
await mark('mount');
/* the mount happens on bikeSync's own half-second reconcile — no debug force */
for (const [ms,n] of [[250,'m00'],[400,'m01'],[500,'m02'],[600,'m03'],[700,'m04'],[800,'m05'],
                      [900,'m06'],[900,'m07'],[900,'m08']]) { await wait(ms); await shot(n); }
console.log('after mount', JSON.stringify(await ev(()=>WALLY.debug.balloonInfo())));

/* ================= 2. RISE ================= */
await mark('rise');
await ev(()=>WALLY.debug.balloonBurn(true));
for (let i=0;i<6;i++){ await wait(2500); await shot('r'+i); }
await ev(()=>WALLY.debug.balloonBurn(false));
console.log('after rise', JSON.stringify(await ev(()=>WALLY.debug.balloonInfo())));

/* ================= 3. CRUISE ================= */
await mark('cruise');
await ev(()=>{ WALLY.debug.balloonStick(0,1); WALLY.debug.balloonBurn(true); });
for (let i=0;i<4;i++){ await wait(3000); await shot('c'+i); }
await ev(()=>{ WALLY.debug.balloonStick(null,null); WALLY.debug.balloonBurn(false); });
const cruise = await ev(()=>WALLY.debug.balloonInfo()); console.log('cruise', JSON.stringify(cruise));

/* ================= 4. DESCEND, LAND, DISMOUNT (flat) ================= */
await mark('land');
await ev(()=>{ WALLY.ctx.game.actions.equipRide(null); });   // the player asks to get out
for (let i=0;i<14;i++){ await wait(2000); await shot('l'+String(i).padStart(2,'0'));
  const s = await ev(()=>WALLY.debug.balloonInfo());
  if (s.phase==='off') { console.log('landed at step',i); break; } }
await wait(2500); await shot('l-final');
console.log('after land', JSON.stringify(await ev(()=>WALLY.debug.balloonInfo())));
await wait(500); await shot('l-parked');

const trk1 = await ev(()=>{ const T=window.__TRK; window.__TRK=[]; return T; });

/* ================= 5. LAND ON A ROOF ================= */
await mark('roof');
const roof = await ev(async () => {
  const g = WALLY.ctx.game;
  g.actions.equipRide('balloon');
  // find a building with a flat-ish roof: use groundAt above the building centre
  const list = WALLY.debug.cityList();
  const out = [];
  for (const b of list) {
    const rec = WALLY.ctx.city.buildingAt(b.id); if (!rec) continue;
    const p = rec.center;
    let hit=null; try { hit = WALLY.ctx.phys.groundAt(p.x, p.z, p.y+60); } catch(e){}
    const terr = WALLY.ctx.world.heightAt(p.x,p.z);
    if (hit && hit.hit && hit.y - terr > 4) out.push({ id:b.id, x:+p.x.toFixed(1), z:+p.z.toFixed(1),
      roofY:+hit.y.toFixed(2), terr:+terr.toFixed(2), h:+(hit.y-terr).toFixed(2), n: hit.normal? +hit.normal.y.toFixed(3):null });
  }
  out.sort((a,b)=>b.h-a.h);
  return out.slice(0,8);
});
console.log('ROOFS', JSON.stringify(roof));
if (roof.length) {
  const t = roof[0];
  await ev((t)=>{ WALLY.debug.balloon({at:[t.x, t.roofY+26, t.z]}); WALLY.debug.balloonStick(0,0); }, t);
  await wait(1200); await shot('roof-0');
  for (let i=0;i<10;i++){ await wait(1500); await shot('roof-'+(i+1));
    const s = await ev(()=>WALLY.debug.balloonInfo());
    if (Math.abs(s.vy) < 0.05 && s.alt < 0.3) break; }
  console.log('roof rest', JSON.stringify(await ev(()=>WALLY.debug.balloonInfo())));
  await ev(()=>{ WALLY.ctx.game.actions.equipRide(null); });
  for (let i=0;i<8;i++){ await wait(1500); const s=await ev(()=>WALLY.debug.balloonInfo()); if(s.phase==='off') break; }
  await wait(1500); await shot('roof-dismount');
  console.log('roof after dismount', JSON.stringify(await ev(()=>({ b:WALLY.debug.balloonInfo(), wally: WALLY.ctx.wally.position.toArray().map(n=>+n.toFixed(2)) }))));
}

/* ================= 6. LAND ON A SLOPE ================= */
await mark('slope');
const slope = await ev(async () => {
  const g = WALLY.ctx.game; g.actions.equipRide('balloon');
  // sweep for the steepest walkable-ish ground within 300 m of origin
  let best=null;
  for (let i=0;i<4000;i++){
    const x=(Math.random()*2-1)*320, z=(Math.random()*2-1)*320;
    if (WALLY.ctx.world.shoreDistAt(x,z) < 25) continue;
    const s = WALLY.ctx.world.slopeAt(x,z);
    if (!best || s > best.s) best={x:+x.toFixed(1),z:+z.toFixed(1),s:+s.toFixed(3),y:+WALLY.ctx.world.heightAt(x,z).toFixed(2)};
  }
  return best;
});
console.log('SLOPE', JSON.stringify(slope));
if (slope) {
  await ev((t)=>{ WALLY.debug.balloon({at:[t.x, t.y+30, t.z]}); WALLY.debug.balloonStick(0,0); }, slope);
  await wait(1200); await shot('slope-0');
  for (let i=0;i<12;i++){ await wait(1500); await shot('slope-'+(i+1));
    const s=await ev(()=>WALLY.debug.balloonInfo()); if (Math.abs(s.vy)<0.05 && s.alt<0.4) break; }
  console.log('slope rest', JSON.stringify(await ev(()=>WALLY.debug.balloonInfo())));
  await ev(()=>{ WALLY.ctx.game.actions.equipRide(null); });
  for (let i=0;i<10;i++){ await wait(1500); const s=await ev(()=>WALLY.debug.balloonInfo()); if(s.phase==='off') break; }
  await wait(1500); await shot('slope-dismount');
}

/* ================= 7. THE SEA ================= */
await mark('sea');
const sea = await ev(async () => {
  const g = WALLY.ctx.game; g.actions.equipRide('balloon');
  // a point well out to sea
  let p=null;
  for (let r=200;r<1200 && !p;r+=20){
    for (let a=0;a<6.28;a+=0.3){
      const x=Math.cos(a)*r, z=Math.sin(a)*r;
      if (WALLY.ctx.world.heightAt(x,z) < (WALLY.ctx.world.seaLevel ?? 0) - 8) { p={x:+x.toFixed(1),z:+z.toFixed(1)}; break; }
    }
  }
  return p;
});
console.log('SEA', JSON.stringify(sea));
if (sea) {
  await ev((t)=>{ WALLY.debug.balloon({at:[t.x, (WALLY.ctx.world.seaLevel??0)+40, t.z]}); WALLY.debug.balloonStick(0,0); }, sea);
  await wait(1000); await shot('sea-0');
  const track=[];
  for (let i=0;i<14;i++){ await wait(2000); await shot('sea-'+(i+1));
    const s=await ev(()=>WALLY.debug.balloonInfo()); track.push({alt:s.alt,vy:s.vy,refusing:s.refusing,floored:s.floored,burner:s.burner}); }
  console.log('SEA TRACK', JSON.stringify(track));
  console.log('sea end', JSON.stringify(await ev(()=>WALLY.debug.balloonInfo())));
  // and ask to get out over the sea
  await ev(()=>{ WALLY.ctx.game.actions.equipRide(null); });
  for (let i=0;i<10;i++){ await wait(2000); const s=await ev(()=>WALLY.debug.balloonInfo());
    if(s.phase==='off'){ console.log('DISMOUNTED OVER SEA at', JSON.stringify(s)); break; } }
  await wait(1500); await shot('sea-dismount');
  console.log('sea after dismount', JSON.stringify(await ev(()=>({ b:WALLY.debug.balloonInfo(), wally: WALLY.ctx.wally.position.toArray().map(n=>+n.toFixed(2)), ground: WALLY.ctx.world.heightAt(WALLY.ctx.wally.position.x, WALLY.ctx.wally.position.z) }))));
}

const trk2 = await ev(()=>window.__TRK);
const analyse = (T, name) => {
  const byMark = {};
  for (let i=1;i<T.length;i++){
    const r=T[i]; const m=r.mark||'?';
    const b = byMark[m] || (byMark[m] = { n:0, camMove:0, camTurn:0, subjMove:0, worst:null, worstTurn:null });
    b.n++;
    if (r.dt > 0.001 && r.dt < 0.12) {   // ignore stalled frames: a 300 ms hitch is not a snap
      if (r.camMove > b.camMove) { b.camMove=r.camMove; b.worst={...r}; }
      if (r.camTurn > b.camTurn) { b.camTurn=r.camTurn; b.worstTurn={...r}; }
      if (r.subjMove > b.subjMove) b.subjMove=r.subjMove;
    }
  }
  console.log(`\n=== ${name}: worst SINGLE-FRAME motion per phase (stalled frames >120ms excluded) ===`);
  for (const [m,b] of Object.entries(byMark)) {
    console.log(` ${m.padEnd(8)} frames ${String(b.n).padStart(5)}  cam move ${b.camMove.toFixed(3)} m` +
      ` (dt ${b.worst?b.worst.dt:'-'}s => ${b.worst?(b.camMove/b.worst.dt).toFixed(1):'-'} m/s)` +
      `  cam turn ${b.camTurn.toFixed(2)} deg` +
      ` (dt ${b.worstTurn?b.worstTurn.dt:'-'}s => ${b.worstTurn?(b.camTurn/b.worstTurn.dt).toFixed(0):'-'} deg/s)` +
      `  subject ${b.subjMove.toFixed(3)} m`);
  }
};
analyse(trk1, 'mount / rise / cruise / land / dismount');
analyse(trk2, 'roof / slope / sea');
if (errs.length) console.log('\nPAGE ERRORS', errs.slice(0,10));
await browser.close(); server.close();
