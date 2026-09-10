import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
const ROOT = process.argv[2];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
const served=new Set(), missing=new Set();
const s=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 const f=join(ROOT,c==='/'?'index.html':c);
 if(!f.startsWith(resolve(ROOT))){rs.writeHead(403).end();return;}
 try{const b=await readFile(f);served.add(c);
  rs.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream'});rs.end(b);}
 catch{ if(!/favicon/.test(c)) missing.add(c); rs.writeHead(404).end('nf');}});
await new Promise(r=>s.listen(0,'127.0.0.1',r));
const port=s.address().port;
const b=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars']});
const p=await b.newPage({viewport:{width:1400,height:800}});
const errs=[];
p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error'&&!/favicon/.test(m.text()))errs.push(m.text());});
await p.goto(`http://127.0.0.1:${port}/${process.argv[3]||'index.html'}`,{waitUntil:'load',timeout:60000});
const ready=await p.waitForFunction('window.__WALLY_READY__===true',null, {timeout:60000}).then(()=>true).catch(()=>false);
await p.waitForTimeout(6000);
const perf=await p.evaluate(()=>window.__WALLY_PERF__||null).catch(()=>null);
const stage=await p.evaluate(()=>(document.getElementById('bootStatus')||{}).textContent).catch(()=>null);
await p.screenshot({path:process.argv[4]||'/tmp/vercheck.png',animations:'allow',timeout:20000});
await b.close(); s.close();
console.log(JSON.stringify({ready,stage,perf,filesServed:served.size,missing:[...missing],errors:errs.slice(0,6)},null,1));
process.exit(ready&&!errs.length&&!missing.size?0:1);
