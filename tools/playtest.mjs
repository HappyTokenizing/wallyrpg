import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png'};
const s=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));
  rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}
 catch{rs.writeHead(404).end();}});
await new Promise(r=>s.listen(0,'127.0.0.1',r));
const port=s.address().port;
const b=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--js-flags=--expose-gc']});
const p=await b.newPage({viewport:{width:1400,height:800}});
const errs=[];
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message.split('\n')[0]));
p.on('console',m=>{const t=m.text();if(m.type()==='error'&&!/favicon/.test(t))errs.push('CONSOLE: '+t.slice(0,180));});
await p.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:60000});
await p.waitForFunction('window.__WALLY_READY__===true',{timeout:60000});
await p.waitForTimeout(3000);
const log=[];
const snap=async(tag)=>{const m=await p.evaluate(()=>({
  heapMB:+((performance.memory?.usedJSHeapSize||0)/1048576).toFixed(1),
  geo:WALLY.ctx.renderer.info.memory.geometries, tex:WALLY.ctx.renderer.info.memory.textures,
  prog:WALLY.ctx.renderer.info.programs?.length||0,
  pos:WALLY.ctx.wally?.root?[+WALLY.ctx.wally.root.position.x.toFixed(1),+WALLY.ctx.wally.root.position.y.toFixed(1),+WALLY.ctx.wally.root.position.z.toFixed(1)]:null,
  day:WALLY.ctx.game?.state?.day, money:WALLY.ctx.game?.state?.money,
  fps:window.__WALLY_PERF__?.fps }));
  log.push({tag,...m}); return m;};
await snap('boot');
// --- movement: hold W, then strafe, then jump ---
for (const [key,ms] of [['KeyW',2500],['KeyA',1200],['KeyS',1200],['KeyD',1200]]) {
  await p.keyboard.down(key); await p.waitForTimeout(ms); await p.keyboard.up(key);
}
await p.keyboard.press('Space'); await p.waitForTimeout(1200);
await snap('after-movement');
// --- UI panels ---
for (const k of ['KeyP','Escape','KeyM','Escape','KeyO','Escape']) {
  await p.keyboard.press(k); await p.waitForTimeout(900);
}
await snap('after-ui');
// --- save / load round trip in-browser ---
const save = await p.evaluate(()=>{ try{
  const g=WALLY.ctx.game; g.state.money=4321; g.save&&g.save(true);
  const txt=g.exportSave?g.exportSave():null;
  g.state.money=1; const ok=g.importSave?g.importSave(txt):null;
  return {exported:!!txt, exportBytes:txt?txt.length:0, moneyAfterImport:g.state.money, importOk:!!ok};
 }catch(e){return {error:e.message};}});
await snap('after-save');
// --- resize ---
for (const [w,h] of [[800,600],[1920,1080],[390,844],[1400,800]]) {
  await p.setViewportSize({width:w,height:h}); await p.waitForTimeout(700);
}
await snap('after-resize');
// --- soak: run 25s, watch for leaks ---
await p.keyboard.down('KeyW');
await p.waitForTimeout(25000);
await p.keyboard.up('KeyW');
await p.evaluate(()=>{ if(window.gc) window.gc(); });
await p.waitForTimeout(1500);
await snap('after-soak');
await p.screenshot({path:'shots/playtest.png',animations:'allow',timeout:20000});
await b.close(); s.close();
console.log(JSON.stringify({log,errors:[...new Set(errs)].slice(0,25),errCount:errs.length,save},null,1));
