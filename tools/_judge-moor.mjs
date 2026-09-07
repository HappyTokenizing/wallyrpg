import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'); const OUT=join(ROOT,'shots/judge/moor');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1600,height:900}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:120000});
await page.waitForTimeout(4500); await mkdir(OUT,{recursive:true});
const ev=(f,a)=>page.evaluate(f,a), wait=m=>page.waitForTimeout(m), shot=n=>page.screenshot({path:join(OUT,n+'.png'),timeout:30000});

/* board, go up 25 m, then land on the flat ground he started on */
await ev(()=>{ const g=WALLY.ctx.game; g.actions.grantRide('balloon'); g.actions.equipRide('balloon'); });
await wait(7000);
await ev(()=>WALLY.debug.balloonBurn(true)); await wait(4000);
await ev(()=>WALLY.debug.balloonBurn(false));
await ev(()=>WALLY.ctx.game.actions.equipRide(null));
for (let i=0;i<40;i++){ await wait(1000); const s=await ev(()=>WALLY.debug.balloonInfo()); if(s.phase==='off'){console.log('landed after',i,'s');break;} }
await wait(2000); await shot('moor-00-justdismounted');
console.log('parked', JSON.stringify(await ev(()=>WALLY.debug.balloonInfo().spot)));
/* walk him away with the real controller so the camera frames it from the ground */
for (const [dx,dz,n] of [[6,6,'moor-01'],[6,6,'moor-02'],[6,-3,'moor-03']]) {
  await ev(([x,z])=>{ const w=WALLY.ctx.wally; w.warp ? w.warp() : 0;
    const p=WALLY.ctx.phys.player.position; WALLY.debug.wallyWarp ? WALLY.debug.wallyWarp(p.x+x,p.z+z) : 0; }, [dx,dz]);
  await wait(1600); await shot(n);
}
/* a proper look at it: put the camera at a player's eye 9 m away */
const look = await ev(()=>{
  const b = WALLY.debug.balloonInfo().spot; if(!b) return null;
  const g = WALLY.ctx.world.heightAt(b.x+8, b.z+8);
  WALLY.debug.camFree();
  WALLY.ctx.camera.position.set(b.x+8, g+1.55, b.z+8);
  WALLY.ctx.camera.lookAt(b.x, b.y+1.4, b.z);
  return { at:[b.x,b.y,b.z] };
});
await wait(900); await shot('moor-eye-a');
await ev(()=>{ const b=WALLY.debug.balloonInfo().spot; const g=WALLY.ctx.world.heightAt(b.x-7,b.z+5);
  WALLY.ctx.camera.position.set(b.x-7, g+1.55, b.z+5); WALLY.ctx.camera.lookAt(b.x,b.y+1.2,b.z); });
await wait(900); await shot('moor-eye-b');
await ev(()=>{ const b=WALLY.debug.balloonInfo().spot; const g=WALLY.ctx.world.heightAt(b.x+3,b.z-4);
  WALLY.ctx.camera.position.set(b.x+3, g+3.2, b.z-4); WALLY.ctx.camera.lookAt(b.x,b.y+0.9,b.z); });
await wait(900); await shot('moor-eye-c');
console.log('LOOK', JSON.stringify(look));

/* ---- night, burner lit ---- */
await ev(()=>{ WALLY.debug.camFollow(); WALLY.debug.setHour(22); WALLY.ctx.game.actions.equipRide('balloon'); });
await wait(8000); await ev(()=>{ WALLY.debug.balloon({alt:35}); WALLY.debug.balloonBurn(true); });
await wait(2500); await shot('night-burner');
await ev(()=>WALLY.debug.balloonBurn(false)); await wait(3000); await shot('night-noburner');
await ev(()=>{ WALLY.debug.setHour(9); }); await wait(1500);
await ev(()=>{ WALLY.debug.balloon({alt:30}); WALLY.debug.balloonBurn(true); }); await wait(2500);
await shot('day-burner');
if (errs.length) console.log('PAGE ERRORS', errs.slice(0,6));
await browser.close(); server.close();
