#!/usr/bin/env node
/* _bt-boot.mjs — boot-time profiler for the BOOT TIME AGENT.
   Watches #bootStage label changes and times the gap between them,
   then prints per-stage ms and total time to __WALLY_READY__.
     node tools/_bt-boot.mjs [--w 1280] [--h 720] [--runs 1] [--console]
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glsl': 'text/plain',
};
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const W = +arg('w', 1280), H = +arg('h', 720), RUNS = +arg('runs', 1);
const QS = arg('qs', '?shot=1');

const server = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});

for (let run = 0; run < RUNS; run++) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}\n${e.stack || ''}`));

  await page.addInitScript(() => {
    window.__BT = { t0: performance.now(), marks: [] };
    const attach = () => {
      const el = document.getElementById('bootStage');
      if (!el) { requestAnimationFrame(attach); return; }
      window.__BT.marks.push({ name: el.textContent || '(start)', t: performance.now() });
      new MutationObserver(() => {
        window.__BT.marks.push({ name: el.textContent, t: performance.now() });
      }).observe(el, { childList: true, characterData: true, subtree: true });
    };
    attach();
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html${QS}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 120000 }).catch(() => logs.push('[warn] never ready'));
  const bt = await page.evaluate(() => ({
    t0: window.__BT.t0, marks: window.__BT.marks, ready: performance.now(),
    npc: (window.WALLY?.ctx?.npc) ? {
      count: window.WALLY.ctx.npc.count,
      named: window.WALLY.ctx.npc.named.size,
      crowd: window.WALLY.ctx.npc.crowd?.agents?.length ?? 0,
      quality: window.WALLY.ctx.quality?.name,
      stats: window.WALLY.ctx.npc.stats,
      perf: window.WALLY.ctx.npc.perf || null,
    } : null,
  }));

  const fill = await page.evaluate(() => new Promise((res) => {
    const t0 = performance.now(); const samples = [];
    const tick = () => {
      const n = window.WALLY?.ctx?.npc;
      samples.push([Math.round(performance.now() - t0), n ? n.queued : -1,
        Math.round(window.__WALLY_PERF__?.fps ?? 0)]);
      if (!n || n.queued === 0 || performance.now() - t0 > 12000) return res(samples);
      setTimeout(tick, 250);
    };
    tick();
  })).catch(() => []);

  const rows = [];
  for (let i = 0; i < bt.marks.length; i++) {
    const a = bt.marks[i], b = bt.marks[i + 1];
    const end = b ? b.t : bt.ready;
    rows.push([a.name, +(end - a.t).toFixed(0)]);
  }
  rows.sort((x, y) => y[1] - x[1]);
  const total = +(bt.ready - bt.t0).toFixed(0);
  console.log(`--- run ${run + 1}  ${W}x${H}  total(nav->ready) ${total} ms`);
  console.log(rows.filter(r => r[1] >= 3).map(r => `  ${r[0].padEnd(10)} ${String(r[1]).padStart(6)} ms`).join('\n'));
  if (bt.npc) console.log('  npc:', JSON.stringify(bt.npc));
  console.log('  fill (ms, queued, fps):', fill.map(f => f.join('/')).join(' '));
  if (flag('console')) console.log(logs.join('\n'));
  else { const e = logs.filter(l => /PAGEERROR|\[error\]/.test(l)); if (e.length) console.log(e.join('\n')); }
  await page.close();
}

await browser.close();
server.close();
