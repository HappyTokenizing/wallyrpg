/* vj-boot.mjs — independent cold-boot timing + bootPct monotonicity */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (rq, rs) => {
  try {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    const p = join(ROOT, c === '/' ? 'index.html' : c);
    const b = await readFile(p);
    rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const QS = process.argv[2] || '';
const RUNS = +(process.argv[3] || 2);

const browser = await chromium.launch({ channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });

for (let r = 0; r < RUNS; r++) {
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctxB.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.addInitScript(() => {
    window.__VJ = { t0: performance.now(), marks: [], pcts: [], fills: [] };
    const poll = () => {
      const st = document.getElementById('bootStage');
      const pc = document.getElementById('bootPct');
      const fl = document.getElementById('bootFill');
      if (st) {
        const m = window.__VJ.marks;
        const label = st.textContent;
        if (!m.length || m[m.length - 1].name !== label) m.push({ name: label, t: performance.now() });
      }
      if (pc) {
        const v = pc.textContent;
        const p = window.__VJ.pcts;
        if (!p.length || p[p.length - 1].v !== v) p.push({ v, t: +(performance.now() - window.__VJ.t0).toFixed(0) });
      }
      if (fl) {
        const w = fl.style.width;
        const f = window.__VJ.fills;
        if (!f.length || f[f.length - 1] !== w) f.push(w);
      }
      if (!window.__WALLY_READY__) requestAnimationFrame(poll);
    };
    poll();
  });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/index.html${QS}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 180000 });
  const wall = Date.now() - t0;
  const d = await page.evaluate(() => ({ t0: window.__VJ.t0, marks: window.__VJ.marks,
    pcts: window.__VJ.pcts, fills: window.__VJ.fills, ready: performance.now() }));
  const rows = [];
  for (let i = 0; i < d.marks.length; i++) {
    const a = d.marks[i], b = d.marks[i + 1];
    rows.push([a.name, +((b ? b.t : d.ready) - a.t).toFixed(0), +(a.t - d.t0).toFixed(0)]);
  }
  console.log(`\n=== run ${r + 1} qs="${QS}"  total(nav->ready) ${(d.ready - d.t0).toFixed(0)} ms   wallclock ${wall} ms`);
  for (const [n, ms, at] of rows) console.log(`   ${String(n).padEnd(12)} ${String(ms).padStart(6)} ms   (starts @${at})`);
  console.log('   bootPct distinct:', d.pcts.map(p => `${p.v}@${p.t}`).join(' '));
  const nums = d.pcts.map(p => parseInt(p.v)).filter(n => Number.isFinite(n));
  let mono = true; for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i-1]) mono = false;
  console.log('   monotonic:', mono, ' distinct count:', nums.length, ' max:', Math.max(...nums));
  console.log('   bootFill widths:', d.fills.join(' '));
  if (errs.length) console.log('   ERRORS:', errs.slice(0,4).join(' | '));
  await ctxB.close();
}
await browser.close(); server.close();
