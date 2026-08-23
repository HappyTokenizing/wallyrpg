import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = createServer(async (rq,rs)=>{ const c=decodeURIComponent(rq.url.split('?')[0]);
  try{ const b=await readFile(join(ROOT,c==='/'?'index.html':c)); rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'}); rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars']});
const ctxB=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});
const page=await ctxB.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:90000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:90000});
await page.waitForTimeout(3000);

await page.evaluate(()=>{
  window.setup=(dest,ride)=>{ const c=WALLY.ctx,st=c.game.state;
    for(const l of c.game.data.locations) st.known[l.id]=true;
    st.money=5000; st.energy=100; st.hunger=10;
    st.rides={owned:{bike:false,scooter:false,motorcycle:false},equipped:null};
    if(ride) st.rides.owned[ride]=true;
    st.bike={owned:!!st.rides.owned.bike,equipped:false};
    c.game.clearRoute('setup'); st.time=10*60;
    c.ui.setDestination(null);
    if(st.loc!=='apartment') c.game.enter('apartment');
    return st.loc; };
  window.snap=()=>{ const c=WALLY.ctx,p=c.wally.position;
    return {loc:c.game.state.loc,pos:[+p.x.toFixed(2),+p.z.toFixed(2)],money:+c.game.state.money.toFixed(2),
      energy:+c.game.state.energy.toFixed(3),time:c.game.state.time,route:c.game.route,
      equipped:c.game.state.rides?.equipped||null, dest:c.ui.hudDestination??null,
      objT:(document.querySelector('.w-obj .t')||{}).textContent||'',
      objD:(document.querySelector('.w-obj .d')||{}).textContent||'',
      objChosen:!!document.querySelector('.w-obj.chosen'),
      travel:c.game.state.travel}; };
  /* tap a row on the REAL fare board */
  window.board=(dest)=>{ const c=WALLY.ctx; const host=document.createElement('div'); document.body.appendChild(host);
    c.ui.renderTravelModes(host,dest,()=>{});
    const out=[...host.querySelectorAll('.w-card')].map(e=>({t:(e.querySelector('.t')||{}).textContent||'',d:(e.querySelector('.d')||{}).textContent||'',m:(e.querySelector('.m')||{}).textContent||'',dis:!!e.disabled}));
    const labels=[...host.querySelectorAll('.w-label')].map(e=>e.textContent.trim());
    host.remove(); return {labels,cards:out}; };
  window.tapRow=(dest,title)=>{ const c=WALLY.ctx; const host=document.createElement('div'); document.body.appendChild(host);
    c.ui.renderTravelModes(host,dest,()=>{});
    const el=[...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'')===title);
    if(!el){host.remove(); return {err:'no row '+title};}
    const dis=!!el.disabled; el.click(); host.remove(); return {dis}; };
});
const ev=(f,...a)=>page.evaluate(f,...a);
let fails=0; const ok=(c,m,x='')=>{ if(!c)fails++; console.log(`${c?'PASS':'FAIL'}  ${m}${x?'   '+x:''}`); };

console.log('\n=== 1. THE BOARD, TAPPED FOR REAL, ALL SIX ROWS ===');
const CASES=[
 {title:'On foot',           mode:'walk',  ride:null,          dest:'noodlecart'},
 {title:'Bicycle',           mode:'bike',  ride:'bike',        dest:'stadium'},
 {title:'Scooter',           mode:'bike',  ride:'scooter',     dest:'bank'},
 {title:'Motorcycle',        mode:'bike',  ride:'motorcycle',  dest:'markethall'},
 {title:'Metro',             mode:'train', ride:null,          dest:'noodlecart'},
 {title:'Yoober',            mode:'trunk', ride:null,          dest:'stadium'},
];
for(const c of CASES){
  await ev(([d,r])=>setup(d,r),[c.dest,c.ride]);
  await page.waitForTimeout(600);
  const b4=await ev(()=>snap());
  const tap=await ev(([d,t])=>tapRow(d,t),[c.dest,c.title]);
  await page.waitForTimeout(1400);
  const a=await ev(()=>snap());
  const dist=Math.hypot(a.pos[0]-b4.pos[0],a.pos[1]-b4.pos[1]);
  const want=await ev((d)=>WALLY.ctx.game.data.locationById[d].n,c.dest);
  console.log(`\n-- ${c.title} -> ${c.dest}  tap=${JSON.stringify(tap)}`);
  console.log(`   loc ${b4.loc}->${a.loc}  moved ${dist.toFixed(2)} m  money ${b4.money}->${a.money}  time ${b4.time}->${a.time}  equipped ${a.equipped}  arrow "${a.objT}" chosen=${a.objChosen}  route=${a.route?a.route.to+'/'+a.route.mode+'/'+a.route.ride:'null'}`);
  const fast=(c.mode==='train'||c.mode==='trunk');
  if(fast){
    ok(a.loc===c.dest, `${c.title}: relocated to ${c.dest}`, a.loc);
    ok(a.money<b4.money, `${c.title}: charged a fare`, `${b4.money} -> ${a.money}`);
    ok(a.time>b4.time, `${c.title}: burned the clock`, `${b4.time} -> ${a.time}`);
    ok(a.route===null, `${c.title}: no route left behind`);
  } else {
    ok(a.loc===b4.loc, `${c.title}: did NOT relocate`, a.loc);
    ok(dist<1.5, `${c.title}: did NOT teleport (${dist.toFixed(2)} m)`);
    ok(a.money===b4.money, `${c.title}: charged no money`);
    ok(a.route&&a.route.to===c.dest&&a.route.mode===c.mode, `${c.title}: route set`, JSON.stringify(a.route));
    ok(a.equipped===c.ride, `${c.title}: equipped=${c.ride}`, String(a.equipped));
    ok(a.objT===want&&a.objChosen, `${c.title}: route ARROW updated to "${want}"`, `"${a.objT}" chosen=${a.objChosen}`);
  }
}
console.log('\n=== 2. THE BOARD AS RENDERED (headings + verbs) ===');
await ev(([d,r])=>setup(d,r),['stadium','bike']);
const bd=await ev((d)=>board(d),'stadium');
console.log('  headings: '+JSON.stringify(bd.labels));
for(const c of bd.cards) console.log(`   ${c.dis?'[disabled]':'[ tap ]'} ${c.t.padEnd(12)} | ${c.m.padEnd(8)} | ${c.d}`);
console.log('\nPAGE ERRORS: '+errs.length, JSON.stringify(errs.slice(0,5)));
console.log(fails?`\nFAIL — ${fails}`:'\nALL GREEN');
await browser.close(); server.close();
