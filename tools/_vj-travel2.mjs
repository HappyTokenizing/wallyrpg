import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT='/Users/herwig/Documents/GitHub/wallyrpg';
const M={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const s=createServer(async(rq,rs)=>{try{const c=decodeURIComponent(rq.url.split('?')[0]);
const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':M[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>s.listen(0,'127.0.0.1',r)); const P=s.address().port;
const br=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio']});
const pg=await br.newPage({viewport:{width:1400,height:820}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
await pg.goto(`http://127.0.0.1:${P}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await pg.waitForFunction('window.__WALLY_READY__===true',{timeout:180000});
await pg.waitForTimeout(3500);
const p=()=>pg.evaluate(()=>{const w=window.WALLY.ctx.wally.root.position;return [+w.x.toFixed(2),+w.y.toFixed(2),+w.z.toFixed(2)];});
console.log('spawn:',await p());
console.log('visibleLocations offered at boot:', JSON.stringify(await pg.evaluate(()=>{
  const c=window.WALLY.ctx; const v=c.game.visibleLocations?c.game.visibleLocations():null;
  return v? v.map(x=>x.id||x.loc?.id||x).slice(0,40): 'n/a';})));
console.log('fares to apartment at boot:', JSON.stringify(await pg.evaluate(()=>{
  try{return window.WALLY.ctx.game.fares('apartment').map(f=>[f.mode,f.ok,f.why]);}catch(e){return 'err '+e.message;}})));
// direct ui.arrive path
const r1=await pg.evaluate(()=>window.WALLY.ctx.ui.arrive('apartment'));
await pg.waitForTimeout(1500);
console.log('ui.arrive("apartment") ->',r1,' pos:',await p());
// now travel somewhere else then back home
await pg.evaluate(()=>{const st=window.WALLY.ctx.game.state;st.known.stadium=true;st.known.apartment=true;st.money=9999;st.energy=100;st.time=600;
  return window.WALLY.ctx.game.travel('stadium','train');});
await pg.waitForTimeout(1500); console.log('after ->stadium:',await p());
const r2=await pg.evaluate(()=>window.WALLY.ctx.game.travel('apartment','train'));
await pg.waitForTimeout(1500); console.log('travel back to apartment ->',JSON.stringify(r2),' pos:',await p());
console.log(errs.length?'ERRORS '+errs.join('|'):'no page errors');
await br.close(); s.close();
