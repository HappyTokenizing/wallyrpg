#!/usr/bin/env node
/* ============================================================
   _sky-envelope.mjs — the balloon envelope must show NO two-band
   terminator at any sun bearing.

   A tone or lighting change is exactly what puts banding back on a
   large smooth curved surface, so this is run before and after any
   change to the sky.

   METHOD. Board the balloon at altitude, put the camera at a fixed
   offset from Wally so the envelope fills a known region, and sweep
   the sun's AZIMUTH through 8 bearings at a fixed hour (the shading is
   a function of the angle between the surface normal and the sun, so
   bearing is the axis that matters, not the hour). Then, on the
   envelope pixels only:

     jump   the largest single-pixel luminance step along a horizontal
            scan through the envelope's widest point, as a fraction of
            that scan's whole luminance range. A two-band ramp puts
            most of the range into one step; a soft-stepped one
            spreads it. > 0.20 is a terminator you can see.
     gap    the fraction of envelope pixels whose luminance falls in
            the middle fifth of the range. Two bands leave that empty.

   WHAT THIS RIG WAS BLIND ON UNTIL ROUND 5, said plainly because it
   has been cited as evidence that the balloon is clean and it was
   only ever evidence about a third of the sky:

     · EIGHT bearings, 45 degrees apart. A two-band terminator is a
       feature of the angle between the surface normal and the sun and
       there is no reason for it to land on a multiple of 45. Now 16,
       at 22.5 degrees, and --hour takes a list so the crossing hours
       can be swept as well as the reference one.
     · THE CREAM MASK WAS A COLOUR KEY, `sat > 0.22 || R < B`, and the
       second half of that is a WARM test. Under a cool sky — which is
       every hour this file's crossing work is about — the lit cream
       gores go cool and the key throws them away, so the rig measured
       whatever was left and found no banding in it. The mask is now
       geometric plus a single albedo split taken from the histogram
       of the disc itself, and `cool%` reports how much of the body
       the old key would have discarded. Any run where cool% is large
       is a run the OLD rig was blind on.

   usage: node tools/_sky-envelope.mjs [--hour 17,7.6] [--tag before]
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; }
const HOURS = arg('hour', '17').split(',').map(Number);
const TAG = arg('tag', 'x');
/* which lighting.js crossing rule to drive — see the RUNTIME REVERT
   block in src/world/lighting.js. Both rules on ONE page load. */
const ENVRULES = arg('rules', 'ship').split(',');
const OUT = arg('out', 'shots/_skyenv');
/* --pr N: PIN THE PIXEL RATIO. This rig boots `?shot=1`, and under
   ?shot renderer.js switches the sharpness governor off at ladder
   step 0 — pixelRatio 1, deliberately, so a shot run is reproducible
   between builds. MEASURED: ?shot=1 in a 900x700 box comes up at
   pixelRatio 1 / buffer 900x700 with govOn false, while the same box
   under ?skipIntro climbs to 1.5 / 1350x1050 in one window. So every
   screenshot gate in tools/ — this one included — has been measuring
   the frame as it was BEFORE the pixel-ratio work, and "the balloon
   is still clean" was only ever proven at ratio 1. --pr re-runs the
   same sweep at the ratio the game actually delivers, and the ratio
   the page ended up at is printed in the header either way. */
const PR = arg('pr', null);

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

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 90000 });
const loadS = (Date.now() - t0) / 1000;
const gpu = await page.evaluate(() => { const gl = WALLY.ctx.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; });
await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });
if (PR != null) await page.evaluate((v) => WALLY.debug.pixelRatio(+v), PR);
const VP = await page.evaluate(() => WALLY.debug.viewport());

const settle = (n0 = 20) => page.evaluate((N) => new Promise(r => { let n = 0; const t = () => (++n > N ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n0);

/* the envelope, measured: throat 2.86 m over the deck, 7.30 m tall,
   7.24 m across (balloon.js). Framed from 26 m out and 6 m up so it
   fills the upper half of a 900x700 frame with sky behind it. */
const SETUP = async (hour, azDeg, rule) => page.evaluate(([hh, az, rule]) => {
  if (rule && WALLY.debug.skyRule) WALLY.debug.skyRule(rule);
  /* BOARD FIRST, THEN SET THE HOUR. setHour() pumps forty frames
     internally; done in the other order those forty frames are spent
     on the ground and the balloon gets the twenty of the settle to
     teleport, reseed its camera (`flyCam.seeded = false`) and be
     found. MEASURED, hour 17.32, sixteen bearings, the old order:
     fifteen of them projected an envelope of under 200 px and the rig
     printed ENVELOPE NOT FOUND for every rule — with the balloon
     simply not in frame, which is what shots/_skyenv showed. That is
     the ninth-instrument failure again: a rig that stops measuring at
     exactly the hour under investigation. */
  WALLY.debug.balloon({ alt: 260 });
  WALLY.debug.setHour(hh);
  const { ctx, THREE } = WALLY;
  /* aim the sun by hand: the dome, the key light and the toon ramp all
     read lighting.sunDirection, so rotating it about Y is a true sun
     bearing sweep and not a camera trick */
  const L = ctx.sky.lighting;
  const d = L.sunDirection;
  const el = Math.asin(clampN(d.y, -1, 1));
  const a = az * Math.PI / 180;
  d.set(Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)).normalize();
  function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  return true;
}, [hour, azDeg, rule]);

/* THE FLY CAMERA OWNS THE TRANSFORM and puts it back every frame —
   measured: a lookAt or an fov set here is gone by the next rAF. So
   nothing is moved. The envelope is located by PROJECTING it through
   whatever camera the rig has settled on, after the settle, which is
   also the honest way to A/B two builds: the framing is the rig's and
   is identical in both. */
const AIM = () => page.evaluate(() => {
  const { ctx, THREE } = WALLY;
  const p = ctx.wally.position.clone();
  const cam = ctx.camera;
  cam.updateMatrixWorld();
  const c = new THREE.Vector3(p.x, p.y + 6.6, p.z);
  const q = c.clone().project(cam);
  const right = new THREE.Vector3().subVectors(cam.position, c).cross(new THREE.Vector3(0, 1, 0)).normalize();
  const q2 = c.clone().addScaledVector(right, 3.62).project(cam);
  return { x: (q.x * 0.5 + 0.5) * window.innerWidth, y: (1 - (q.y * 0.5 + 0.5)) * window.innerHeight,
           r: Math.abs((q2.x - q.x) * 0.5 * window.innerWidth),
           pos: [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)] };
});

const MEASURE = async ([url, cx, cy, r]) => {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const w = bmp.width, h = bmp.height, d = g.getImageData(0, 0, w, h).data;
  /* THE MASK IS GEOMETRIC, NOT A COLOUR GUESS. The envelope is
     projected from its measured 3.62 m half-width, and only the CREAM
     gores are measured — the orange ones have a different albedo, so a
     luminance step between two neighbouring gores is a stripe edge and
     not a terminator. Within one albedo, any step IS shading. */
  const x0 = Math.max(1, Math.round(cx - r * 0.92)), x1 = Math.min(w - 2, Math.round(cx + r * 0.92));
  const y0 = Math.max(1, Math.round(cy - r * 0.92)), y1 = Math.min(h - 2, Math.round(cy + r * 0.92));
  if (x1 - x0 < 30 || y1 - y0 < 30) return { found: false };
  /* THE ALBEDO SPLIT IS SELF-CALIBRATING, and it has to be. The fixed
     `sat > 0.22` this replaced is an absolute threshold on a quantity
     the sun moves: at 07:39 it kept 2000 cream pixels a bearing, and
     at 17:19 — a warmer key on the same envelope — it kept between 13
     and 38, and the rig printed ENVELOPE NOT FOUND for all sixteen
     bearings. A rig that silently stops measuring at exactly the hour
     under investigation is the failure contracts.js rule 3 is about.

     So the split is taken from the disc's OWN saturation histogram:
     the cream gores are the less saturated of the two albedos whatever
     the light is doing, so the lower two fifths of the distribution is
     one albedo by construction. */
  const px = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / r, dy = (y - cy) / r;
      if (dx * dx + dy * dy > 0.55 * 0.55) continue;       // well inside the body
      const o = (y * w + x) * 4;
      const R = d[o], G = d[o + 1], B = d[o + 2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      px.push([mx > 0 ? (mx - mn) / mx : 0, 0.2126 * R + 0.7152 * G + 0.0722 * B, R < B ? 1 : 0]);
    }
  }
  if (px.length < 200) return { found: false, n: px.length };
  const sats = px.map(v => v[0]).sort((a, b) => a - b);
  /* THE PERCENTILE ALONE, AND THE `Math.min(0.22, ...)` THAT USED TO
     BE HERE WAS THE ABSOLUTE THRESHOLD THIS BLOCK SAYS IT REPLACED,
     still in the expression. Whenever the whole envelope is more
     saturated than 0.22 — which is every bearing of the AFTERNOON
     crossing, where the key is a warm cream — the clamp won the min
     and the split stopped being self-calibrating: MEASURED, hour
     17.32, sixteen bearings, it kept 15 to 26 cream pixels out of a
     properly framed disc and the rig printed ENVELOPE NOT FOUND for
     every one of them. A percentile keeps 40 % of the disc by
     construction, at any exposure, which is what "the cream gores are
     the less saturated of the two albedos whatever the light is
     doing" actually means. */
  const cut = sats[Math.floor(sats.length * 0.40)];
  const lums = []; let cool = 0;
  for (const [sat, L, c] of px) { if (sat > cut) continue; cool += c; lums.push(L); }
  if (lums.length < 200) return { found: false, n: lums.length };
  lums.sort((a, b) => a - b);
  const lo = lums[Math.floor(lums.length * 0.02)], hi = lums[Math.floor(lums.length * 0.98)];
  const range = hi - lo;
  /* A TWO-BAND TERMINATOR IS A HOLE IN THE HISTOGRAM. Bucket the body
     into ten bands of its own range; a soft-stepped ramp fills them
     all, a hard two-band one leaves the middle ones empty. `dip` is
     the emptiest of the four middle buckets as a fraction of the mean
     bucket.

     READ IT THIS WAY ROUND. A smooth ramp fills the middle buckets, so
     `dip` is HIGH. A hard two-band terminator empties them, so `dip` is
     LOW. LOW IS THE DEFECT. The sentence that stood here until now said
     "below ~0.35 there is no terminator to see", which is the metric
     read backwards, and it is why every sweep taken with this rig has
     reported a threshold it could not support: under the correct
     reading its own cells (0.03-0.28) claim banding on every build,
     under the printed one they claim it on none.
     Until this rig is recalibrated against a known-banded control it is
     usable for COMPARING two builds at the same bearing and hour, which
     is what the rulings that cite it actually rest on, and not as an
     absolute threshold. Do not quote a bare `dip` as proof of anything. */
  const B = 10, hist = new Array(B).fill(0);
  for (const v of lums) { let k = Math.floor((v - lo) / (range || 1) * B); if (k < 0) k = 0; if (k >= B) k = B - 1; hist[k]++; }
  const mean = lums.length / B;
  let dip = 1;
  for (let k = 3; k <= 6; k++) dip = Math.min(dip, hist[k] / mean);
  return { found: true, n: lums.length, range: +range.toFixed(1), dip: +dip.toFixed(3),
    cool: +(100 * cool / lums.length).toFixed(1), cut: +cut.toFixed(3),
    hist: hist.map((v) => +(v / mean).toFixed(2)) };
};

const rows = [];
for (const hour of HOURS) {
  for (const az of [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5]) {
   for (const rule of ENVRULES) {
    await SETUP(hour, az, rule);
    await settle(60);
    /* AND THE FRAMING IS CHECKED BEFORE IT IS MEASURED. The fly camera
       chases a balloon that drifts on the wind, so "settled" is a
       claim about this bearing, not about the run. If the projected
       disc is too small or off screen, give it another second and look
       again; if it is still not there, say WHY — a radius and a
       centre — rather than printing a pixel count that reads like a
       shading result. */
    /* framed = the measured disc (0.55 r) is wholly on screen, not
       merely its centre. A centre-only test passes with the balloon
       half out of frame and then MEASURE clips the sample box and
       returns a pixel count that reads like a shading result. */
    const framed = (c) => c.r > 40
      && c.x - c.r * 0.6 > 0 && c.x + c.r * 0.6 < 900
      && c.y - c.r * 0.6 > 0 && c.y + c.r * 0.6 < 700;
    let c = await AIM();
    for (let tries = 0; tries < 4 && !framed(c); tries++) { await settle(60); c = await AIM(); }
    if (!framed(c)) {
      rows.push({ hour, az, rule, found: false, why: `disc r=${c.r.toFixed(0)} centred (${c.x.toFixed(0)},${c.y.toFixed(0)}) in 900x700, wally at ${c.pos.join('/')} — NOT FRAMED. This is the rig, not the shading.` });
      continue;
    }
    const buf = await page.screenshot({ animations: 'allow' });
    const st = await page.evaluate(MEASURE, [`data:image/png;base64,${buf.toString('base64')}`, c.x, c.y, c.r]);
    rows.push({ hour, az, rule, ...st });
    if (true) {
      await mkdir(resolve(ROOT, OUT), { recursive: true }).catch(() => {});
      await writeFile(resolve(ROOT, OUT, `${TAG}-${rule}-h${hour}-az${String(az).replace('.', 'p')}.png`), buf);
    }
   }
  }
}
await browser.close(); server.close();
console.log(`GPU: ${gpu}  load: ${loadS.toFixed(2)}s   tag=${TAG}   pixelRatio ${VP.pixelRatio} (ceiling ${VP.prCeiling}), buffer ${VP.buffer.join('x')}, msaa ${VP.samples}${PR!=null?' — PINNED with --pr':' — ?shot default'}`);
console.log('hour  sunAz rule   creamPx  range  histDip  cool%  satCut  histogram (10 buckets, 1.0 = even)');
for (const r of rows) {
  console.log(r.found
    ? `${String(r.hour).padEnd(5)} ${String(r.az).padStart(5)} ${String(r.rule).padEnd(5)}  ${String(r.n).padStart(6)}  ${String(r.range).padStart(5)}  ${String(r.dip).padStart(6)}  ${String(r.cool).padStart(5)}  ${String(r.cut).padStart(5)}   ${r.hist.join(' ')}`
    : `${r.hour} ${r.az} ${r.rule}  ENVELOPE NOT FOUND — ${r.why || `n=${r.n} cream px after the albedo split`}`);
}
if (errs.length) console.log('page errors:', errs.slice(0, 5).join(' | '));
