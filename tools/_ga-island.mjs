#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro&partcensus`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
console.log(JSON.stringify(await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const want = new Set(['stadium', 'learning.fill3']);
  const out = [];
  for (const b of c.city.partCensus()) {
    if (!want.has(b.id)) continue;
    const p = b.parts, TOL = 0.02;
    const par = p.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      const a = p[i], o = p[j];
      const gx = Math.max(a.min[0] - o.max[0], o.min[0] - a.max[0], 0);
      const gy = Math.max(a.min[1] - o.max[1], o.min[1] - a.max[1], 0);
      const gz = Math.max(a.min[2] - o.max[2], o.min[2] - a.max[2], 0);
      if (Math.hypot(gx, gy, gz) <= TOL) { const x = find(i), y = find(j); if (x !== y) par[x] = y; }
    }
    const size = new Map();
    for (let i = 0; i < p.length; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
    let main = -1, best = -1; for (const [r, n] of size) if (n > best) { best = n; main = r; }
    const groups = new Map();
    for (let i = 0; i < p.length; i++) { const r = find(i); if (r === main) continue; (groups.get(r) || groups.set(r, []).get(r)).push(i); }
    for (const [, idxs] of groups) {
      if (idxs.length < 3) continue;
      let gap = Infinity, near = null;
      let lo=[1e9,1e9,1e9], hi=[-1e9,-1e9,-1e9];
      for (const i of idxs) for (let k=0;k<3;k++){lo[k]=Math.min(lo[k],p[i].min[k]);hi[k]=Math.max(hi[k],p[i].max[k]);}
      for (let j = 0; j < p.length; j++) {
        if (find(j) !== main) continue;
        const o = p[j];
        const gx = Math.max(lo[0]-o.max[0], o.min[0]-hi[0], 0), gy = Math.max(lo[1]-o.max[1], o.min[1]-hi[1], 0), gz = Math.max(lo[2]-o.max[2], o.min[2]-hi[2], 0);
        const g = Math.hypot(gx,gy,gz); if (g < gap) { gap = g; near = { part: o.part, min: o.min.map(v=>+v.toFixed(2)), max: o.max.map(v=>+v.toFixed(2)), axis: [+gx.toFixed(3),+gy.toFixed(3),+gz.toFixed(3)] }; }
      }
      out.push({ id: b.id, n: idxs.length, gap: +gap.toFixed(3),
        parts: idxs.slice(0,6).map(i=>({ part: p[i].part, min: p[i].min.map(v=>+v.toFixed(2)), max: p[i].max.map(v=>+v.toFixed(2)) })),
        lo: lo.map(v=>+v.toFixed(2)), hi: hi.map(v=>+v.toFixed(2)), near });
    }
  }
  return out;
}), null, 1));
await browser.close(); server.close();
