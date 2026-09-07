#!/usr/bin/env node
/* ============================================================
   _k28-art.mjs — THE TWO ART LAWS THE RESOLUTION TRADE MOVES.

   ART_DIRECTION §1.2: "Grain: fine and uniform ... clearly visible in
   a close-up, invisible as noise at gameplay distance. If a frame
   reads 'fuzzy' or 'dirty', the grain is too coarse or too strong."
   §2.2: the inverted-hull outline is a ~1.6 CSS-px stroke and is the
   game's signature. MSAA cannot help it — it is geometry drawn in the
   forward pass, not an edge to be resampled.

   Grain is a post pass at BUFFER resolution, so one grain cell is one
   buffer pixel and the compositor blows it up by (dsf / pixelRatio)
   on its way to the eye. That is arithmetic; this file MEASURES it,
   because the arithmetic is only true if the pass really is at buffer
   resolution and the compositor really is doing a plain upscale.

   HOW. The world is frozen (every hook but the renderer's nulled), so
   two captures of the same instant differ ONLY by the thing switched
   between them.

     grain   = |shipped - setGrain(0)|.  Its RMS is the strength in
               8-bit levels ON THE DELIVERED SURFACE; the lag at which
               its normalised autocorrelation falls through 0.5 is the
               cell radius in OUTPUT PIXELS. A cell of 1 output px is
               at the eye's limit; 3 output px is a blob.
     outline = |setGrain(0) - hull off|.  Median horizontal run length
               of the changed band is the delivered stroke width in
               OUTPUT pixels, and /dsf puts it back in the CSS pixels
               §2.2 is written in.

   THE ORDER IS LOAD-BEARING AND IT BIT _k27-ref ONCE. toon.js writes
   uOutlineScale from its OWN update(), which the freeze nulls — so
   calling setOutline after the freeze leaves the shader reading the
   old value while the setter reports 0. This writes the shared uniform
   object directly and PRINTS WHAT A LIVE MATERIAL ACTUALLY HOLDS, so
   a control that did not fire cannot look like a null result.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PLACE = arg('place', 'cafe');
const MAXLOAD = +arg('maxload', 5);
const KEEP = arg('keep', null);
const ONLY = arg('only', null);
const HOUR = arg('hour', '12.5');

const tmp = await mkdtemp(join(tmpdir(), 'k28art-'));
if (KEEP) await mkdir(KEEP, { recursive: true });

const PY = String.raw`
import sys, json
import numpy as np
from PIL import Image

def L(p):
    return np.asarray(Image.open(p).convert('L')).astype(np.float32)

def acorr_halfwidth(d):
    """Lag at which the normalised autocorrelation of the difference
       image first falls through 0.5, along x and along y. For white
       noise generated at 1/k of the sampling rate this is ~k/2."""
    d = d - d.mean()
    out = {}
    for axis, nm in ((1, 'x'), (0, 'y')):
        v = float((d*d).mean())
        if v <= 1e-9: out[nm] = None; continue
        lags = []
        for k in range(1, 9):
            a = np.take(d, range(0, d.shape[axis]-k), axis=axis)
            b = np.take(d, range(k, d.shape[axis]), axis=axis)
            lags.append(float((a*b).mean()/v))
        prev, hw = 1.0, None
        for i, c in enumerate(lags):
            if c < 0.5:
                # linear interpolation between lag i and i+1
                hw = i + (prev-0.5)/max(1e-9, prev-c)
                break
            prev = c
        out[nm] = round(hw, 3) if hw is not None else '>8'
    return out

def runlen(mask):
    """Mean and median horizontal run length of True in a boolean mask."""
    runs = []
    for row in mask:
        n = 0
        for v in row:
            if v: n += 1
            elif n: runs.append(n); n = 0
        if n: runs.append(n)
    if not runs: return None, None, 0
    return float(np.mean(runs)), float(np.median(runs)), len(runs)

spec = json.load(open(sys.argv[1]))
out = {}
for row in spec['rows']:
    name = row['name']; x, y, w, h = row['crop']
    A = L(row['shipped'])[y:y+h, x:x+w]
    B = L(row['nograin'])[y:y+h, x:x+w]
    C = L(row['noline'])[y:y+h, x:x+w]
    g = A - B
    r = {}
    r['grainRMS'] = round(float(np.sqrt((g*g).mean())), 4)
    r['grainP99'] = round(float(np.percentile(np.abs(g), 99)), 3)
    r['grainCell'] = acorr_halfwidth(g)
    # ABSOLUTE threshold, in 8-bit levels. A percentile threshold is
    # self-normalising - it selects the same 1% of pixels whatever the
    # stroke is doing, so the width it reports CANNOT move and looks
    # stable for the wrong reason. 8 levels is well clear of the
    # 3-level grain p99 and of compositor ringing.
    o = np.abs(B - C)
    mask = o > 8.0
    mean, ml, n = runlen(mask)
    r['strokeMean'] = round(mean, 3) if mean else None
    r['strokeMed'] = round(ml, 3) if ml else None
    r['strokeN'] = n
    r['strokeCover'] = round(float(mask.mean())*100, 3)
    r['ink'] = round(float(o.sum())/1e3, 1)
    out[name] = r
print(json.dumps(out))
`;
await writeFile(join(tmp, 'a.py'), PY);

const FREEZE = () => {
  const ctx = window.WALLY.ctx;
  const keep = ctx.render;
  let n = 0;
  for (const h of ctx._handles || []) {
    if (!h || h === keep) continue;
    for (const k of ['update', 'lateUpdate']) {
      if (typeof h[k] === 'function' && !h['__k28' + k]) { h['__k28' + k] = h[k]; h[k] = () => {}; n++; }
    }
  }
  return n;
};
/* Write the SHARED uniform object directly — toon.update() is nulled
   by the freeze and can no longer put it back or overwrite it. */
const SETHULL = (v) => {
  let hit = 0, seen = null;
  window.WALLY.ctx.scene.traverse(o => {
    const u = o.material && o.material.uniforms && o.material.uniforms.uOutlineScale;
    if (u) { u.value = v; hit++; seen = u.value; }
  });
  return { hit, seen };
};
const READHULL = () => {
  let v = null;
  window.WALLY.ctx.scene.traverse(o => {
    const u = o.material && o.material.uniforms && o.material.uniforms.uOutlineScale;
    if (v == null && u) v = u.value;
  });
  return v;
};

const VIEWPORTS = [
  { label: 'desktop 1600x900 @ dsf 2 (tier high)', w: 1600, h: 900, phone: false, dsf: 2,
    prs: [1, 1.264, 1.5, 2], crop: { x: 500, y: 250, w: 500, h: 400 } },
  { label: 'phone   390x844  @ dsf 3 (tier med)',  w: 390, h: 844, phone: true, dsf: 3,
    prs: [1, 2, 3], crop: { x: 30, y: 280, w: 330, h: 330 } },
];

const F = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

console.log('# _k28-art — film grain coarseness and inverted-hull stroke width, in OUTPUT pixels, per option.');
console.log('# rig: headless Chrome (channel chrome), WebGL2 ANGLE Metal, Apple M1 Max. World FROZEN, one page load per viewport.');
console.log(`# ?skipIntro&hour=${HOUR}, arrive('${PLACE}'), governor OFF. Three captures per ratio: shipped / grain off / grain+hull off.`);
console.log('# grainCell is the autocorrelation half-width of (shipped - grainOff) in OUTPUT px. Predicted = dsf/(2*pixelRatio) for a');
console.log('#   one-buffer-pixel cell blown up by the compositor. strokePx is the delivered hull width on the surface; /dsf = CSS px,');
console.log('#   which is the unit ART_DIRECTION 2.2 writes its ~1.6 px in.\n');

for (const V of VIEWPORTS) {
  if (ONLY && !V.label.startsWith(ONLY)) continue;
  const l0 = await loadGate(MAXLOAD);
  const logs = [];
  const { page, close } = await boot({ w: V.w, h: V.h, phone: V.phone, dpr: V.dsf, logs, qs: `?skipIntro&hour=${HOUR}` });
  await sleep(5000);
  const arrived = await page.evaluate((p) => { try { return WALLY.debug.arrive(p, true) === true; } catch (e) { return false; } }, PLACE);
  await sleep(6000);
  await page.evaluate(() => WALLY.debug.governor(false));
  const env = await page.evaluate(ENVSTATE);
  const frozen = await page.evaluate(FREEZE);
  await sleep(1200);
  const hull0 = await page.evaluate(READHULL);

  console.log(`=== ${V.label}   devicePixelRatio ${env.dpr}  tier '${env.tier}'  tier msaa ${env.msaa}  arrive ${arrived ? 'TRUE' : 'FALSE — boot position'}`);
  console.log(`    hooks nulled ${frozen}   uOutlineScale in a live material at rest: ${hull0}   crop (CSS px) ${JSON.stringify(V.crop)}`);

  const rows = [];
  for (const pr of V.prs) {
    await page.evaluate((p) => WALLY.debug.pixelRatio(p), pr);
    await sleep(2000);
    const vp = await page.evaluate(() => WALLY.debug.viewport());
    /* toon.update is nulled by the freeze, so uOutlineScale would be
       stuck at whatever it held when the freeze landed and the stroke
       would shrink with every ratio for a reason that never happens in
       the game. Replicate the shipped rule by hand — toon.js:
       uOutlineScale = outlineScaleUser * min(max(pixelRatio,1),2) —
       so the stroke measured here is the stroke that ships. */
    const hullNow = await page.evaluate((p) => {
      const want = Math.min(Math.max(p, 1), 2);
      let hit = 0; window.WALLY.ctx.scene.traverse(o => {
        const u = o.material && o.material.uniforms && o.material.uniforms.uOutlineScale;
        if (u) { u.value = want; hit++; }
      });
      return want;
    }, pr);
    await sleep(600);
    const shipped = join(tmp, `${V.w}_pr${String(pr).replace('.', '_')}_a.png`);
    await page.screenshot({ path: shipped });

    await page.evaluate(() => WALLY.ctx.render.setGrain(0));
    await sleep(900);
    const nograin = join(tmp, `${V.w}_pr${String(pr).replace('.', '_')}_b.png`);
    await page.screenshot({ path: nograin });

    const off = await page.evaluate(SETHULL, 0);
    await sleep(900);
    const seenOff = await page.evaluate(READHULL);
    const noline = join(tmp, `${V.w}_pr${String(pr).replace('.', '_')}_c.png`);
    await page.screenshot({ path: noline });

    /* put both back for the next ratio */
    await page.evaluate(SETHULL, hullNow);
    await page.evaluate(() => WALLY.ctx.render.setGrain(WALLY.ctx.quality.grain === false ? 0 : undefined));
    await page.evaluate(() => { const p = WALLY.ctx.render.post; }); // no-op, keeps eval symmetric
    await page.evaluate(() => WALLY.ctx.render.setPost(true));
    await sleep(900);

    rows.push({ pr, vp, hullNow, hullOff: seenOff, hullHits: off.hit, shipped, nograin, noline });
  }

  const spec = { rows: rows.map(r => ({
    name: String(r.pr),
    crop: [Math.round(V.crop.x * V.dsf), Math.round(V.crop.y * V.dsf), Math.round(V.crop.w * V.dsf), Math.round(V.crop.h * V.dsf)],
    shipped: r.shipped, nograin: r.nograin, noline: r.noline })) };
  await writeFile(join(tmp, `spec${V.w}.json`), JSON.stringify(spec));
  const res = JSON.parse(execSync(`python3 ${join(tmp, 'a.py')} ${join(tmp, `spec${V.w}.json`)}`, { maxBuffer: 1 << 26 }).toString());

  console.log('    ' + F('pr', 8) + F('buffer', 12) + R('grainRMS', 10) + R('p99', 6) +
    R('cell(out px)', 14) + R('predicted', 11) + R('cellCSSpx', 11) + '|' + R('strokeMean', 12) + R('med', 6) +
    R('= CSS px', 10) + R('cover%', 9) + R('ink k', 8) + '   uOutlineScale');
  for (const r of rows) {
    const m = res[String(r.pr)];
    const pred = (V.dsf / (2 * r.pr)).toFixed(3);
    const cell = (m.grainCell.x + m.grainCell.y);            // full cell diameter, output px
    console.log('    ' + F(r.pr, 8) + F(`${r.vp.buffer[0]}x${r.vp.buffer[1]}`, 12) +
      R(m.grainRMS, 10) + R(m.grainP99, 6) + R(cell.toFixed(3), 14) + R((2 * pred).toFixed(3), 11) +
      R((cell / V.dsf).toFixed(3), 11) + '|' +
      R(m.strokeMean ?? '-', 12) + R(m.strokeMed ?? '-', 6) +
      R(m.strokeMean ? (m.strokeMean / V.dsf).toFixed(3) : '-', 10) + R(m.strokeCover, 9) + R(m.ink, 8) +
      `   on ${r.hullNow} -> off ${r.hullOff} (${r.hullHits} mats)`);
  }
  console.log(`    load before ${l0} -> after ${load1()};  page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}`);
  if (KEEP) for (const r of rows) execSync(`cp ${r.shipped} ${join(KEEP, `${V.w}_pr${String(r.pr).replace('.', '_')}.png`)}`);
  console.log('');
  await close();
}
console.log(`# PNGs: ${KEEP || tmp}`);
console.log(`# load (1-min) at end: ${load1()}`);
