#!/usr/bin/env node
/* ============================================================
   _judge-env.mjs — THE BALLOON ENVELOPE, CLOSE UP.

   WHY THIS EXISTS RATHER THAN tools/_sky-envelope.mjs. That rig's
   header says the envelope is "framed from 26 m out and 6 m up so it
   fills the upper half of a 900x700 frame"; measured, it does not —
   the balloon's fly camera owns the transform, the rig accepts
   whatever chase view it gets, and the envelope lands about 70 px
   across in a 900x700 frame. Consequences, all of them in its own
   output: 209-492 sampled pixels at 17:19 against 1826-1966 at 07:38,
   ENVELOPE NOT FOUND at three of eight bearings at 17:19, and n = 0 at
   ALL EIGHT bearings at 18:00, because its cream-gore mask
   (sat <= 0.22 && R >= B) rejects an envelope that dusk has turned
   orange. Eight of twenty-four bearing-hours actually measured.

   THE CAMERA IS TAKEN INSIDE THE RENDER TASK. The fly camera puts its
   own transform back every frame, so a lookAt from a rig is gone by
   the next rAF — which is what that rig ran into. Here the camera is
   positioned and ctx.render.render() is called in the SAME JS task,
   before any rAF can run, and gl.readPixels reads the frame back
   before the compositor clears it. Nothing can overwrite the
   transform in between.

   MEASURED, on envelope pixels found by DEPTH-FREE geometric
   projection of the envelope's own centre and radius, split by gore
   albedo rather than by an absolute colour gate (the two gore colours
   are separated by k-means on hue within the disc, so a dusk-orange
   cream gore is still a cream gore):

     step   largest single-pixel luminance jump along the horizontal
            scan through the widest point, as a fraction of that
            scan's range. A two-band terminator puts most of the
            range into one step.
     mid    fraction of envelope pixels in the middle fifth of the
            luminance range. Two bands leave it EMPTY, so LOW IS BAD
            — the opposite of the reading _sky-envelope.mjs's header
            gives its own `dip` ("below ~0.35 there is no terminator
            to see"), which is inverted with respect to the histogram
            it describes.

   usage: node tools/_judge-env.mjs --hours 7.638,17.323,18,18.5 \
            --rules prev,ship --out shots/_jenv2
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const HOURS = arg('hours', '7.638,17.323,18').split(',').map(Number);
const RULES = arg('rules', 'prev,ship').split(',');
const AZ = arg('az', '0,45,90,135,180,225,270,315').split(',').map(Number);
const OUT = arg('out', null);

const server = createServer(async (req, res) => {
  try {
    const c = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, c === '/' ? 'index.html' : c);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
let browser = null; const rows = []; let gpu = '?'; const errs = [];
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 720, height: 720 } });
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 90000 });
  gpu = await page.evaluate(() => { const gl = WALLY.ctx.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; });
  await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });
  await page.evaluate(() => { WALLY.debug.balloon({ alt: 260 }); });
  const settle = () => page.evaluate(() => new Promise(r => { let n = 0; const t = () => (++n > 12 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

  const SHOT = async ([hh, az, rule, wantPng]) => {
    const { ctx, THREE } = WALLY;
    if (rule && WALLY.debug.skyRule) WALLY.debug.skyRule(rule);
    WALLY.debug.setHour(hh);
    const L = ctx.sky.lighting, d = L.sunDirection;
    const el = Math.asin(Math.max(-1, Math.min(1, d.y))), a = az * Math.PI / 180;
    d.set(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)).normalize();
    /* THE CAMERA IS TAKEN INSIDE THE RENDER TASK — see the header. */
    const cam = ctx.camera, p = ctx.wally.position;
    const c = new THREE.Vector3(p.x, p.y + 6.6, p.z);
    const ca = (az + 55) * Math.PI / 180;                 /* a three-quarter view of the lit side */
    cam.position.set(c.x + Math.sin(ca) * 15, c.y + 3.2, c.z + Math.cos(ca) * 15);
    cam.lookAt(c); cam.fov = 34; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    ctx.render.render();
    const r = ctx.renderer, gl = r.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4); r.setRenderTarget(null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const sc = h / window.innerHeight;
    const q = c.clone().project(cam);
    const right = new THREE.Vector3().subVectors(cam.position, c).cross(new THREE.Vector3(0, 1, 0)).normalize();
    const q2 = c.clone().addScaledVector(right, 3.62).project(cam);
    const cx = (q.x * 0.5 + 0.5) * w, cyTop = (1 - (q.y * 0.5 + 0.5)) * h;
    const rad = Math.abs((q2.x - q.x) * 0.5 * w);
    const at = (x, yTop) => { const yb = h - 1 - Math.round(yTop); const o = (yb * w + Math.round(x)) * 4; return [px[o], px[o + 1], px[o + 2]]; };
    const lum = (c2) => 0.2126 * c2[0] + 0.7152 * c2[1] + 0.0722 * c2[2];
    if (!(rad > 20)) return { found: false, rad: +rad.toFixed(1) };
    /* body pixels, split into two gore families by hue k-means */
    const body = [];
    for (let yy = Math.max(1, Math.round(cyTop - rad * 0.8)); yy <= Math.min(h - 2, Math.round(cyTop + rad * 0.8)); yy++)
      for (let xx = Math.max(1, Math.round(cx - rad * 0.8)); xx <= Math.min(w - 2, Math.round(cx + rad * 0.8)); xx++) {
        const dx = (xx - cx) / rad, dy = (yy - cyTop) / rad;
        if (dx * dx + dy * dy > 0.62 * 0.62) continue;
        const c2 = at(xx, yy); body.push([xx, yy, c2[0], c2[1], c2[2], lum(c2)]);
      }
    if (body.length < 400) return { found: false, rad: +rad.toFixed(1), n: body.length };
    /* two families by SATURATION (the cream gore is the paler one) */
    const sat = body.map(b => { const mx = Math.max(b[2], b[3], b[4]), mn = Math.min(b[2], b[3], b[4]); return mx > 0 ? (mx - mn) / mx : 0; });
    const ss = [...sat].sort((a2, b2) => a2 - b2);
    const cut = ss[Math.floor(ss.length * 0.5)];
    const fam = body.filter((b, i) => sat[i] <= cut);      /* the paler gores */
    const L2 = fam.map(b => b[5]).sort((a2, b2) => a2 - b2);
    const lo = L2[Math.floor(L2.length * 0.02)], hi = L2[Math.floor(L2.length * 0.98)], range = hi - lo;
    let mid = 0; for (const v of L2) if (v > lo + range * 0.4 && v < lo + range * 0.6) mid++;
    /* the widest horizontal scan, on the pale family only */
    const rowY = Math.round(cyTop);
    const scan = fam.filter(b => Math.abs(b[1] - rowY) <= 1).sort((a2, b2) => a2[0] - b2[0]);
    let step = 0;
    for (let i = 1; i < scan.length; i++) if (scan[i][0] - scan[i - 1][0] <= 2) step = Math.max(step, Math.abs(scan[i][5] - scan[i - 1][5]));
    let dataUrl = null;
    if (wantPng) {
      /* THE IMAGE IS THE PIXELS THAT WERE MEASURED. A page.screenshot()
         here would be a different frame drawn by the fly camera, which
         is the whole trap this rig exists to avoid. */
      const sz = Math.min(Math.round(rad * 1.7), Math.min(w, h)), x0 = Math.round(cx - sz / 2), y0 = Math.round(cyTop - sz / 2);
      const oc = new OffscreenCanvas(sz, sz), g = oc.getContext('2d');
      const img = g.createImageData(sz, sz);
      for (let yy = 0; yy < sz; yy++) for (let xx = 0; xx < sz; xx++) {
        const sx = x0 + xx, sy = y0 + yy, o = (yy * sz + xx) * 4;
        img.data[o + 3] = 255;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const c2 = at(sx, sy); img.data[o] = c2[0]; img.data[o + 1] = c2[1]; img.data[o + 2] = c2[2];
      }
      g.putImageData(img, 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/png' });
      dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    }
    return { found: true, rad: +rad.toFixed(1), n: fam.length, range: +range.toFixed(1), step: +(range > 0 ? step / range : 0).toFixed(3), mid: +(100 * mid / L2.length).toFixed(1), scanN: scan.length, dataUrl };
  };

  for (const hh of HOURS) for (const az of AZ) for (const rule of RULES) {
    await settle();
    const st = await page.evaluate(SHOT, [hh, az, rule, !!OUT]);
    if (st.dataUrl) {
      await mkdir(resolve(ROOT, OUT), { recursive: true }).catch(() => {});
      await writeFile(resolve(ROOT, OUT, `${rule}-h${String(hh).replace('.', 'p')}-az${az}.png`), Buffer.from(st.dataUrl.split(',')[1], 'base64'));
    }
    delete st.dataUrl;
    rows.push({ hour: hh, az, rule, ...st });
  }
} finally { if (browser) await browser.close(); server.close(); }
console.log(`GPU ${gpu}   720x720   envelope radius in px is reported: the old rig measured ~35`);
console.log('hour     az   rule   radPx  palePx  range  STEP   MID%   scanN');
for (const r of rows) console.log(r.found
  ? `${String(r.hour).padEnd(8)} ${String(r.az).padStart(3)}  ${r.rule.padEnd(5)} ${String(r.rad).padStart(6)} ${String(r.n).padStart(7)} ${String(r.range).padStart(6)} ${String(r.step).padStart(6)} ${String(r.mid).padStart(6)} ${String(r.scanN).padStart(6)}`
  : `${String(r.hour).padEnd(8)} ${String(r.az).padStart(3)}  ${r.rule.padEnd(5)} NOT FOUND rad=${r.rad} n=${r.n ?? '-'}`);
if (errs.length) console.log('page errors: ' + errs.slice(0, 4).join(' | '));
