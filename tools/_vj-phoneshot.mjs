import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png' };
const server = createServer(async (rq,rs)=>{ const c=decodeURIComponent(rq.url.split('?')[0]);
  try{ const b=await readFile(join(ROOT,c==='/'?'index.html':c));
    rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'}); rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars']});
const ctx=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('PAGEERROR',e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:60000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:60000});
await page.waitForTimeout(9000);
await page.screenshot({path:join(ROOT,'shots/vj-phone-touch.png')});
const info = await page.evaluate(()=>{
  const g=(s)=>{const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect();
    const cs=getComputedStyle(e);
    return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),op:cs.opacity,disp:cs.display,vis:cs.visibility};};
  return {
    stickzone:g('.w-stickzone'), stick:g('.w-stick'), jump:g('.w-abtn.jump'),
    btns:[...document.querySelectorAll('.w-abtn')].map(b=>{const r=b.getBoundingClientRect();return{t:b.textContent.trim().slice(0,12),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}}),
    hints:[...document.querySelectorAll('.w-hint')].map(h=>{const r=h.getBoundingClientRect();return{t:h.textContent.trim().slice(0,20),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}}),
    vw:innerWidth, vh:innerHeight,
    touch: WALLY.debug.touchState(),
  };
});
console.log(JSON.stringify(info,null,1));
await browser.close(); server.close();
