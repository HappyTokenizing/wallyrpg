/* Look at one local point on one building, from a player's eye height.
   Rule 5: dies if arrive() is not true, and prints where the eye ended
   up and what is under it. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>-1&&process.argv[i+1]?process.argv[i+1]:d;};
const OUT=process.argv[2]||'shots/_pa.png', LOC=arg('loc','noodlecart');
const P=JSON.parse(arg('p','[1.707,0.80,2.72]'));     // local target
const EYE=JSON.parse(arg('eye','[1.4,1.55,7.5]'));    // local eye
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.mjs':'text/javascript'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars']});
const page=await browser.newPage({viewport:{width:+arg('w',1400),height:+arg('h',900)}});
let err=null; page.on('pageerror',e=>{err=e.message.split('\n')[0];});
page.on('console',m=>{ if(/error|warn/i.test(m.type())) console.log('['+m.type()+']',m.text().slice(0,200)); });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro`,{waitUntil:'load',timeout:180000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:180000});
await page.waitForTimeout(3500);
const ok = await page.evaluate((l)=>WALLY.debug.arrive(l,true)===true, LOC);
if(!ok){ console.error('arrive('+LOC+') did not return true'); await browser.close(); server.close(); process.exit(1); }
await page.waitForTimeout(2500);
await page.evaluate((h)=>{window.__PA_HIDE__=h;}, process.argv.includes('--hide'));
const info = await page.evaluate(({LOC,P,EYE})=>{
  const c=WALLY.ctx,T=WALLY.THREE;
  const rec=c.city.locations.get(LOC); if(!rec) return {bad:'no record'};
  const loc=rec.loc, g=rec.group||null;
  const yaw=loc.yaw||0, cs=Math.cos(yaw), sn=Math.sin(yaw);
  const base = g ? g.position.clone() : new T.Vector3(loc.world.x,0,loc.world.z);
  const toW=(p)=>new T.Vector3(base.x + p[0]*cs + p[2]*sn, base.y + p[1], base.z - p[0]*sn + p[2]*cs);
  const tgt=toW(P), eye=toW(EYE);
  c.cam.camera ? 0 : 0;
  const cam=c.camera;
  if(c.cam && c.cam.setFree) c.cam.setFree(true);
  cam.position.copy(eye); cam.lookAt(tgt); cam.updateMatrixWorld();
  if(c.cam) c.cam.freeze?.(true);
  if(window.__PA_HIDE__){ c.wally?.group && (c.wally.group.visible=false);
    c.scene.getObjectByName('npc') && (c.scene.getObjectByName('npc').visible=false);
    for(const el of document.querySelectorAll('body > *:not(canvas)')) el.style.display='none'; }
  const gy=c.world.heightAt(eye.x,eye.z);
  return { base:[+base.x.toFixed(2),+base.y.toFixed(2),+base.z.toFixed(2)], yaw:+yaw.toFixed(3),
    eye:[+eye.x.toFixed(2),+eye.y.toFixed(2),+eye.z.toFixed(2)], tgt:[+tgt.x.toFixed(2),+tgt.y.toFixed(2),+tgt.z.toFixed(2)],
    groundUnderEye:+gy.toFixed(2), zone:c.world.zoneAt(eye.x,eye.z)?.id||c.world.zoneAt(eye.x,eye.z)||'?',
    stall: rec.meta ? rec.meta.stall : (rec.meta===undefined?'no meta on record':null) };
},{LOC,P,EYE});
console.log('# rig: headless Chrome (channel chrome), SwiftShader, '+arg('w',1400)+'x'+arg('h',900)+', load '+(await import('node:child_process')).execSync('uptime').toString().split('load averages:')[1].trim());
console.log('#', JSON.stringify(info));
await page.waitForTimeout(700);
await mkdir(dirname(join(ROOT,OUT)),{recursive:true});
await page.screenshot({path:join(ROOT,OUT)});
if(err) console.log('PAGEERROR', err);
await browser.close(); server.close();
