#!/usr/bin/env node
/* ============================================================
   _j22-inside.mjs — THE CROSSING FROM INSIDE THE CITY.

   Every sky measurement in this repo is taken from 150 m over open
   water with an empty frame. A player is on the ground, between
   buildings, and often indoors: the sky reaches them through gaps.
   That changes two things a dome measurement cannot see —

     · how much sky is in frame at all (skyPx%), and
     · what the sky's own colour does to the LIT SURFACES, which is
       where a crossing is actually noticed once the sky is a slot
       between two roofs. scene.fog and the ambient come off the same
       table entries the crossing rewrites, so the whole street
       changes colour even when no sky is visible.

   The camera is put at a named location's own position at eye height
   and swung through 8 bearings. Whatever is in frame is reported
   honestly: this measures the STREET, and where the location's
   interior point is inside a shell it measures that.
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try { const c = decodeURIComponent(req.url.split('?')[0]); const p = join(ROOT, c === '/' ? 'index.html' : c);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(p); res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 120000 });
await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });
const settle = () => page.evaluate(() => new Promise(r => { let n = 0; const t = () => (++n > 20 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

const locs = await page.evaluate(() => {
  const city = WALLY.ctx.city || WALLY.ctx.world.city;
  const out = [];
  for (const id of ['apartment', 'trunkdepot', 'pawnshop', 'diner', 'bank', 'gym', 'cafe', 'office']) {
    const v = city?.interiorAnchor?.(id);
    if (v) out.push({ id, x: +v.x.toFixed(1), y: +v.y.toFixed(1), z: +v.z.toFixed(1) });
  }
  return { out, hasCity: !!city, keys: Object.keys(WALLY.ctx).join(',') };
});
console.log(`ctx keys: ${locs.keys}`);
console.log(`interior anchors resolved: ${locs.out.map(l => l.id + '@' + l.x + ',' + l.y + ',' + l.z).join('  ')}`);
const IDS = locs.out.slice(0, 2).map(l => l.id);

const AIM = ([hh, off, rule, loc]) => {
  WALLY.debug.skyRule(rule); WALLY.debug.setHour(hh);
  const { ctx } = WALLY; ctx.cam?.setEnabled?.(false);
  const city = ctx.city || ctx.world.city;
  const P = city.interiorAnchor(loc);
  const cam = ctx.camera;
  const d = ctx.sky.sunDirection; const az = Math.atan2(d.x, d.z) + off * Math.PI / 180;
  cam.position.set(P.x, P.y, P.z);
  cam.lookAt(P.x + Math.sin(az) * 400, P.y + 40, P.z + Math.cos(az) * 400);
  cam.updateMatrixWorld();
  return { loc, y: +P.y.toFixed(2) };
};

const MEASURE = async ([url]) => {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0); const w = bmp.width, h = bmp.height, d = g.getImageData(0, 0, w, h).data;
  /* the sky is what the DEPTH says is far; no depth here, so it is
     approximated by the top third's brightest, least-textured pixels —
     stated as an approximation rather than sold as a mask */
  let R = 0, G = 0, B = 0, n = 0, gs = 0, skyish = 0, tot = 0;
  let fR = 0, fG = 0, fB = 0, fn = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const o = (y * w + x) * 4, r = d[o], gv = d[o + 1], b = d[o + 2];
    tot++;
    const lum = 0.2126 * r + 0.7152 * gv + 0.0722 * b;
    if (y < h * 0.45 && b > gv * 0.92 && lum > 90) { R += r; G += gv; B += b; n++; skyish++; if (gv < r && gv < b) gs++; }
    if (y > h * 0.6) { fR += r; fG += gv; fB += b; fn++; }        /* the ground/street half */
  }
  const sat = (a) => { const x = Math.max(...a), y = Math.min(...a); return +(x > 0 ? (x - y) / x : 0).toFixed(3); };
  const hex = (a) => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const skyMean = n ? [R / n, G / n, B / n] : null, gMean = [fR / fn, fG / fn, fB / fn];
  return { skyPx: +(100 * skyish / tot).toFixed(1), sky: skyMean ? hex(skyMean) : '-', skySat: skyMean ? sat(skyMean) : 0,
    gSmall: n ? +(100 * gs / n).toFixed(1) : 0, street: hex(gMean), streetSat: sat(gMean) };
};

const OUT = 'shots/_j22in';
await mkdir(resolve(ROOT, OUT), { recursive: true }).catch(() => { });
console.log('\nhour   loc            off  rule  | skyPx%  skyMean  skySat  gSmall  streetMean streetSat');
for (const hour of [7.65, 17.32, 12]) for (const loc of IDS) for (const off of [0, 180])
  for (const rule of ['prev', 'warp', 'ship']) {
    const st0 = await page.evaluate(AIM, [hour, off, rule, loc]);
    await settle();
    const buf = await page.screenshot({ animations: 'allow' });
    const m = await page.evaluate(MEASURE, [`data:image/png;base64,${buf.toString('base64')}`]);
    await writeFile(resolve(ROOT, OUT, `in-${hour}-${loc}-${off}-${rule}.png`), buf);
    console.log(`${String(hour).padEnd(6)} ${String(st0.loc).padEnd(14)} ${String(off).padStart(3)}  ${rule.padEnd(5)}| ` +
      `${String(m.skyPx).padStart(6)}  ${m.sky}  ${String(m.skySat).padEnd(6)}  ${String(m.gSmall).padStart(5)}%  ${m.street}   ${m.streetSat}`);
  }
await browser.close(); server.close();
