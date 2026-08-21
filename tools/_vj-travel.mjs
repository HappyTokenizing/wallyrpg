import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT='/Users/herwig/Documents/GitHub/wallyrpg';
const M={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const s=createServer(async(rq,rs)=>{try{const c=decodeURIComponent(rq.url.split('?')[0]);
const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':M[extname(c)]||'application/octet-stream','cache-control':'no-store'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>s.listen(0,'127.0.0.1',r)); const P=s.address().port;
const br=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio']});
const pg=await br.newPage({viewport:{width:1400,height:820}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
pg.on('console',m=>{if(m.type()==='error')errs.push('con: '+m.text().slice(0,160));});
await pg.goto(`http://127.0.0.1:${P}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await pg.waitForFunction('window.__WALLY_READY__===true',{timeout:180000});
await pg.waitForTimeout(3500);

const snap = () => pg.evaluate(()=>{const c=window.WALLY.ctx,w=c.wally;
  return {loc:c.game.state.loc, pos:[+w.root.position.x.toFixed(2),+w.root.position.y.toFixed(2),+w.root.position.z.toFixed(2)],
    hud:(document.querySelector('#ui')?.innerText||'').split('\n').filter(Boolean).slice(0,6)};});

const before = await snap();
console.log('BEFORE  loc=%s pos=%j', before.loc, before.pos);

// farthest location from spawn
const far = await pg.evaluate(()=>{const c=window.WALLY.ctx; const p=c.wally.root.position;
  let best=null; for(const L of c.game.data.locations){ const d=c.city.doorPosition(L.id); if(!d) continue;
    const dist=Math.hypot(d.x-p.x,d.z-p.z); if(!best||dist>best.dist) best={id:L.id,name:L.name,dist:+dist.toFixed(1),door:[+d.x.toFixed(2),+d.y.toFixed(2),+d.z.toFixed(2)]}; }
  return best;});
console.log('farthest location from spawn:', JSON.stringify(far));

const r = await pg.evaluate((id)=>{const c=window.WALLY.ctx,st=c.game.state;
  st.known[id]=true; st.money=9999; st.energy=100; st.time=10*60;
  return c.game.travel(id,'train');}, 'stadium');
console.log('travel() ->', JSON.stringify(r));
await pg.waitForTimeout(2500);
const after = await snap();
const chk = await pg.evaluate((id)=>{const c=window.WALLY.ctx,w=c.wally,ct=w.controller;
  const d=c.city.doorPosition(id); const p=w.root.position;
  const fin=v=>!!v&&Number.isFinite(v.x+v.y+v.z);
  return {dist:+Math.hypot(p.x-d.x,p.z-d.z).toFixed(2),
    finite: fin(p)&&fin(ct.simPosition)&&fin(ct.position)&&fin(ct._prevPosition)&&fin(ct.velocity),
    ground:+(p.y-c.world.heightAt(p.x,p.z)).toFixed(2),
    camDist:+Math.hypot(c.camera.position.x-p.x,c.camera.position.z-p.z).toFixed(2),
    nearestBuilding: (()=>{let b=null;for(const [k,rec] of c.city.locations){const dd=Math.hypot(rec.door.x-p.x,rec.door.z-p.z);if(!b||dd<b.d)b={id:k,d:+dd.toFixed(2)};}return b;})()};}, 'stadium');
console.log('AFTER   loc=%s pos=%j', after.loc, after.pos);
console.log('check  ', JSON.stringify(chk));
console.log('HUD after:', JSON.stringify(after.hud));

// now WALK a few metres to prove the controller is live at the new place
await pg.keyboard.down('KeyW'); await pg.waitForTimeout(1800); await pg.keyboard.up('KeyW');
await pg.waitForTimeout(600);
const walked = await snap();
console.log('after walking 1.8s:', JSON.stringify(walked.pos));
await pg.screenshot({path:join(ROOT,'shots','vj-travel-arrival.png')});
console.log(errs.length? 'ERRORS: '+errs.slice(0,5).join(' | ') : 'no page errors');
await br.close(); s.close();
