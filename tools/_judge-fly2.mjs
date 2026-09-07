#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'shots/judge/fly2');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = createServer(async (rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:120000});
await page.waitForTimeout(4500); await mkdir(OUT,{recursive:true});
const ev=(f,a)=>page.evaluate(f,a); const wait=(ms)=>page.waitForTimeout(ms);
const shot=(n)=>page.screenshot({path:join(OUT,n+'.png'),timeout:30000});

/* ============ 0. the mount, frame by frame, camera tracked ============ */
await ev(()=>{ window.__TRK=[]; const c=WALLY.ctx.camera;
  let last=performance.now(), lp=c.position.clone(), lq=c.quaternion.clone();
  const tick=()=>{ const n=performance.now(), dt=(n-last)/1000; last=n;
    let d=lq.x*c.quaternion.x+lq.y*c.quaternion.y+lq.z*c.quaternion.z+lq.w*c.quaternion.w; d=Math.min(1,Math.abs(d));
    let fi=null; try{fi=WALLY.debug.balloonInfo();}catch(e){}
    window.__TRK.push({i:window.__TRK.length, dt:+dt.toFixed(4), mv:+c.position.distanceTo(lp).toFixed(4),
      tn:+(2*Math.acos(d)*57.2958).toFixed(3), fov:+c.fov.toFixed(2), mode:WALLY.ctx.cam?.mode||'',
      cam:[+c.position.x.toFixed(2),+c.position.y.toFixed(2),+c.position.z.toFixed(2)],
      ph:fi?fi.phase:'', alt:fi?+fi.alt.toFixed(2):0, inf:fi?+fi.inflate.toFixed(2):0});
    lp.copy(c.position); lq.copy(c.quaternion);
    if(window.__TRK.length<4000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick); });
await wait(1500);
await ev(()=>{ const g=WALLY.ctx.game; g.actions.grantRide('balloon'); g.actions.equipRide('balloon'); });
await wait(9000);
const mountTrk = await ev(()=>{ const T=window.__TRK; window.__TRK=null; return T; });
let worst=null; for (const r of mountTrk) if (r.dt>0.001&&r.dt<0.12&&(!worst||r.tn>worst.tn)) worst=r;
console.log('MOUNT worst turn frame:', JSON.stringify(worst));
const wi = mountTrk.indexOf(worst);
console.log('MOUNT frames', wi-6, '..', wi+6);
for (let i=Math.max(0,wi-6); i<Math.min(mountTrk.length,wi+7); i++) console.log('  ', JSON.stringify(mountTrk[i]));
let mvW=null; for (const r of mountTrk) if (r.dt>0.001&&r.dt<0.12&&(!mvW||r.mv>mvW.mv)) mvW=r;
console.log('MOUNT worst move frame:', JSON.stringify(mvW));
const mi = mountTrk.indexOf(mvW);
for (let i=Math.max(0,mi-4); i<Math.min(mountTrk.length,mi+5); i++) console.log('  M', JSON.stringify(mountTrk[i]));

/* ============ 1. ROOFS — with groundAt called correctly ============ */
const roofs = await ev(() => {
  const out=[];
  for (const b of WALLY.debug.cityList()) {
    const rec = WALLY.ctx.city.buildingAt(b.id); if(!rec) continue;
    const p = rec.center;
    const g = WALLY.ctx.phys.groundAt(p.x, p.z);      // default: cast from the top of the world
    const terr = WALLY.ctx.world.heightAt(p.x,p.z);
    out.push({ id:b.id, kit:b.kit, x:+p.x.toFixed(1), z:+p.z.toFixed(1),
      solidY:+g.y.toFixed(2), hit:g.hit, ny:+g.normal.y.toFixed(3),
      terr:+terr.toFixed(2), above:+(g.y-terr).toFixed(2) });
  }
  out.sort((a,b)=>b.above-a.above); return out;
});
console.log('\nROOFS (solid surface at each building centre, cast from the top of the world):');
for (const r of roofs.slice(0,10)) console.log('  ', JSON.stringify(r));
console.log('   ...buildings whose centre has NO solid above terrain:', roofs.filter(r=>r.above<1).length, 'of', roofs.length);

/* ============ 2. LAND ON THE BEST ROOF ============ */
const target = roofs.find(r=>r.above>4 && r.ny>0.9) || roofs[0];
console.log('\nROOF TARGET', JSON.stringify(target));
await ev((t)=>{ WALLY.ctx.game.actions.equipRide('balloon');
  WALLY.debug.balloon({at:[t.x,t.solidY+22,t.z]}); WALLY.debug.balloonStick(0,0); }, target);
await wait(1500); await shot('roof-a');
const roofTrack=[];
for (let i=0;i<16;i++){ await wait(1500);
  const s=await ev(()=>({b:WALLY.debug.balloonInfo(), y:WALLY.ctx.wally.position.y}));
  roofTrack.push({alt:+s.b.alt.toFixed(2),vy:+s.b.vy.toFixed(2),g:+s.b.ground.toFixed(2),ph:s.b.phase,ref:s.b.refusing});
  if (Math.abs(s.b.vy)<0.06 && s.b.alt<0.3) break; }
await shot('roof-b');
console.log('ROOF DESCENT', JSON.stringify(roofTrack));
await ev(()=>WALLY.ctx.game.actions.equipRide(null));
for (let i=0;i<10;i++){ await wait(1200); const s=await ev(()=>WALLY.debug.balloonInfo()); if(s.phase==='off') break; }
await wait(1500); await shot('roof-c');
console.log('ROOF AFTER DISMOUNT', JSON.stringify(await ev(()=>({b:WALLY.debug.balloonInfo(),
  w:WALLY.ctx.wally.position.toArray().map(n=>+n.toFixed(2)),
  terr:+WALLY.ctx.world.heightAt(WALLY.ctx.wally.position.x,WALLY.ctx.wally.position.z).toFixed(2)}))));

/* ============ 3. A WALKABLE SLOPE ============ */
const slope = await ev(() => { let best=null;
  for(let i=0;i<20000;i++){ const x=(Math.random()*2-1)*300, z=(Math.random()*2-1)*300;
    if (WALLY.ctx.world.shoreDistAt(x,z)<30) continue;
    const s=WALLY.ctx.world.slopeAt(x,z);
    if (s>0.22 && s<0.34 && (!best||s>best.s)) best={x:+x.toFixed(1),z:+z.toFixed(1),s:+s.toFixed(3),y:+WALLY.ctx.world.heightAt(x,z).toFixed(2)};}
  return best; });
console.log('\nSLOPE TARGET', JSON.stringify(slope));
await ev((t)=>{ WALLY.ctx.game.actions.equipRide('balloon');
  WALLY.debug.balloon({at:[t.x,t.y+22,t.z]}); WALLY.debug.balloonStick(0,0); }, slope);
await wait(1500); await shot('slope-a');
const st=[];
for (let i=0;i<16;i++){ await wait(1500); const s=await ev(()=>WALLY.debug.balloonInfo());
  st.push({alt:+s.alt.toFixed(2),vy:+s.vy.toFixed(2),ref:s.refusing});
  if (Math.abs(s.vy)<0.06 && s.alt<0.3) break; }
await shot('slope-b'); console.log('SLOPE DESCENT', JSON.stringify(st));
await ev(()=>WALLY.ctx.game.actions.equipRide(null));
for (let i=0;i<10;i++){ await wait(1200); const s=await ev(()=>WALLY.debug.balloonInfo()); if(s.phase==='off') break; }
await wait(1500); await shot('slope-c');
const sp = await ev(()=>({b:WALLY.debug.balloonInfo(), w:WALLY.ctx.wally.position.toArray().map(n=>+n.toFixed(2))}));
console.log('SLOPE AFTER DISMOUNT', JSON.stringify(sp));
/* is the parked machine standing on the hill or through it? */
console.log('PARKED POSE', JSON.stringify(await ev(()=>{ let g=null;
  WALLY.ctx.scene.traverse(o=>{ if(o.name==='balloon.envGroup') g=o; });
  const p = g? g.parent : null;
  return p? { name:p.name, pos:p.position.toArray().map(n=>+n.toFixed(2)),
    rot:[p.rotation.x,p.rotation.y,p.rotation.z].map(n=>+(n*57.2958).toFixed(1)), vis:p.visible } : null; })));

/* ============ 4. FLY INTO A TALL BUILDING AT LOW ALTITUDE ============ */
const tall = roofs.filter(r=>r.above>8).sort((a,b)=>b.above-a.above)[0] || roofs[0];
console.log('\nWALL TARGET', JSON.stringify(tall));
const wallRun = await ev(async (t) => {
  WALLY.ctx.game.actions.equipRide('balloon');
  // start 45 m out at 8 m altitude and drive straight at it
  const dx = 45, terr = WALLY.ctx.world.heightAt(t.x-dx, t.z);
  WALLY.debug.balloon({at:[t.x-dx, terr+0.26+8, t.z]});
  await new Promise(r=>{let n=0;const k=()=>(++n>30?r():requestAnimationFrame(k));requestAnimationFrame(k);});
  WALLY.debug.balloonStick(1,0);       // straight at it in +x
  const log=[]; const t0=performance.now();
  let prevY = WALLY.ctx.wally.position.y, maxJump=0, jumpAt=null;
  while (performance.now()-t0 < 26000) {
    await new Promise(r=>requestAnimationFrame(r));
    const w = WALLY.ctx.wally.position; const i = WALLY.debug.balloonInfo();
    const j = Math.abs(w.y - prevY); if (j>maxJump){maxJump=j; jumpAt={x:+w.x.toFixed(2),y:+w.y.toFixed(2),z:+w.z.toFixed(2),alt:+i.alt.toFixed(2),g:+i.ground.toFixed(2)};}
    prevY = w.y;
    if (log.length===0 || performance.now()-log[log.length-1].ms>900)
      log.push({ms:performance.now(), x:+w.x.toFixed(1), y:+w.y.toFixed(2), z:+w.z.toFixed(1),
        alt:+i.alt.toFixed(2), g:+i.ground.toFixed(2), dx:+(t.x-w.x).toFixed(1)});
  }
  WALLY.debug.balloonStick(null,null);
  return { log, maxJump:+maxJump.toFixed(3), jumpAt, target:t };
}, tall);
console.log('WALL RUN maxJump', wallRun.maxJump, 'm at', JSON.stringify(wallRun.jumpAt));
for (const l of wallRun.log) console.log('   ', JSON.stringify(l));
await shot('wall-end');
if (errs.length) console.log('\nPAGE ERRORS', errs.slice(0,10));
await browser.close(); server.close();
