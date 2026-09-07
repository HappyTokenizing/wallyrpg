#!/usr/bin/env node
/* judge multi-shot rig: boot once, run a JSON script of steps, shoot each. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';

const ROOT = process.env.WROOT || '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.json':'application/json', '.png':'image/png' };
const scriptPath = process.argv[2];
const OUTDIR = process.argv[3] || join(ROOT, 'shots/judge');
const W = +(process.env.SW || 1600), H = +(process.env.SH || 900);
const QS = process.env.QS || '?skipIntro&shot=1';
const steps = JSON.parse(await readFile(scriptPath, 'utf8'));

const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream', 'cache-control':'no-store' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel:'chrome', args:[
  '--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization',
  '--force-color-profile=srgb','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport:{ width:W, height:H }, deviceScaleFactor:1 });
const logs = [];
page.on('console', m => { if (/error|warn/i.test(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/index.html${QS}`, { waitUntil:'load', timeout:120000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout:120000 }).catch(()=>logs.push('[warn] never ready'));
await page.waitForTimeout(+(process.env.SETTLE || 3500));
await mkdir(OUTDIR, { recursive:true });
const out = [];
for (const s of steps) {
  let r = null;
  if (s.eval) r = await page.evaluate(s.eval).catch(e => ({ __err: e.message }));
  if (s.wait) await page.waitForTimeout(s.wait);
  await page.evaluate(() => new Promise(r => { let n=0; const t=()=>(++n>6?r():requestAnimationFrame(t)); requestAnimationFrame(t); })).catch(()=>{});
  let post = null;
  if (s.post) post = await page.evaluate(s.post).catch(e => ({ __err: e.message }));
  if (s.name) await page.screenshot({ path: join(OUTDIR, s.name + '.png'), timeout: 30000 });
  const perf = await page.evaluate(() => window.__WALLY_PERF__ || null).catch(()=>null);
  out.push({ step: s.name || s.id || '(noshot)', eval: r, post, perf });
  console.log(JSON.stringify({ step: s.name || s.id, eval: r, post, perf }));
}
if (logs.length) console.log('--- LOGS ---\n' + logs.slice(0,40).join('\n'));
await writeFile(join(OUTDIR, '_results.json'), JSON.stringify(out, null, 1));
await browser.close(); server.close();
