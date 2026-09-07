#!/usr/bin/env node
/* ============================================================
   _j26-sharp.mjs — IS IT SHARPER, IN PIXELS?

   "It renders at dpr 2 now" is a statement about a setting. This
   measures the image a player's eye receives.

   THE CAPTURE. deviceScaleFactor is FIXED for a whole viewport block,
   so the composited surface Chrome hands back is a constant size — a
   390x844 CSS box at dsf 3 is always a 1170x2532 PNG. The ONLY thing
   that moves between rows is the size of the WebGL drawing buffer,
   which the compositor then scales up to that surface. Everything else
   — the world, the camera, the hour, the streamed foliage, every
   compiled program — is identical, because it is ONE PAGE LOAD and the
   ratio is pinned with WALLY.debug.pixelRatio(v), the same shipped
   syncViewport path the governor uses.

   THE FOUR NUMBERS, all on the composited PNG:

     lap    mean |Laplacian| of luma. Bulk high-frequency energy.
     edgeW  THE ONE THAT ANSWERS THE QUESTION. For every strong
            horizontal gradient peak, sum|dx| over a +-4 px window
            divided by the peak itself: how many OUTPUT pixels one
            edge is smeared across. An ideal step is 1.0; a 390-wide
            buffer blown up to 1170 puts every step over 3 px and
            reads ~3. It is a length, not a score, so it can be
            checked against the scale factor by hand.
     p99dx  99th percentile of |first difference| — the height of the
            steepest single-pixel step that survived to the surface.
     hf     share of FFT power above 0.2 cyc/px, radially averaged on
            a windowed 1024 crop.

   THE CONTROL GROUP IS IN THE SAME PNG. The HUD is DOM and SVG on the
   #ui layer ABOVE the canvas; the compositor draws it at the full
   device pixel ratio no matter what the renderer is doing. So the HUD
   crop MUST NOT move as the drawing buffer changes, and the world crop
   MUST. A rig where both move is measuring its own screenshot
   pipeline; a rig where neither moves is measuring nothing. Both crops
   are printed on every row so that is visible rather than asserted.

   NOISE. The world is alive — wind, grass, NPCs, water. Three
   captures per row, ~700 ms apart; the median is reported and the
   spread (max-min) beside it, so a difference smaller than the frame
   to frame noise cannot be read as a win.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PLACE = arg('place', 'mainstreet');
const MAXLOAD = +arg('maxload', 5);
const KEEP = arg('keep', null);          // dir to keep the PNGs in
const NOGRAIN = process.argv.includes('--nograin');
const ONLY = arg('only', null);           // 'phone' | 'desktop'

const tmp = await mkdtemp(join(tmpdir(), 'j26sharp-'));
if (KEEP) await mkdir(KEEP, { recursive: true });

const PY = String.raw`
import sys, json
import numpy as np
from PIL import Image

def metrics(a):
    a = a.astype(np.float32)
    if a.size < 400: return None
    lap = 4*a[1:-1,1:-1] - a[:-2,1:-1] - a[2:,1:-1] - a[1:-1,:-2] - a[1:-1,2:]
    lapm = float(np.abs(lap).mean())
    g = np.abs(np.diff(a, axis=1))
    p99 = float(np.percentile(g, 99))
    # edge width: sum of |dx| over a +-4 window / the peak, at strong peaks
    thr = float(np.percentile(g, 99.5))
    H, W = g.shape
    W_ = 4
    core = g[:, W_:W-W_]
    left = g[:, W_-1:W-W_-1]; right = g[:, W_+1:W-W_+1]
    sel = (core > thr) & (core >= left) & (core > right)
    idx = np.argwhere(sel)
    widths = []
    if len(idx):
        step = max(1, len(idx)//4000)
        for r, c in idx[::step]:
            cc = c + W_
            pk = g[r, cc]
            if pk <= 0: continue
            widths.append(float(g[r, cc-W_:cc+W_+1].sum() / pk))
    edgeW = float(np.median(widths)) if widths else float('nan')
    nEdge = len(widths)
    # high-frequency share of FFT power, windowed square crop
    n = min(1024, a.shape[0], a.shape[1])
    n -= n % 2
    y0 = (a.shape[0]-n)//2; x0 = (a.shape[1]-n)//2
    c = a[y0:y0+n, x0:x0+n]
    win = np.outer(np.hanning(n), np.hanning(n))
    F = np.fft.fftshift(np.abs(np.fft.fft2((c - c.mean())*win)))**2
    yy, xx = np.mgrid[0:n, 0:n]
    r = np.sqrt((yy-n/2)**2 + (xx-n/2)**2) / (n/2) * 0.5   # cyc/px, 0..~0.707
    tot = F[r <= 0.5].sum()
    hf = float(F[(r > 0.2) & (r <= 0.5)].sum() / tot) if tot > 0 else float('nan')
    return dict(lap=round(lapm,4), edgeW=round(edgeW,3), nEdge=nEdge,
                p99dx=round(p99,3), hf=round(hf,5))

out = {}
spec = json.load(open(sys.argv[1]))
for name, path, crops in spec:
    im = Image.open(path).convert('L')
    a = np.asarray(im)
    row = {'size': [a.shape[1], a.shape[0]]}
    for cn, (x, y, w, h) in crops.items():
        sub = a[y:y+h, x:x+w]
        row[cn] = metrics(sub)
    out[name] = row
print(json.dumps(out))
`;
await writeFile(join(tmp, 'm.py'), PY);

const VIEWPORTS = [
  { label: 'phone   390x844  @ deviceScaleFactor 3  (touch, mobile UA)',
    w: 390, h: 844, phone: true, dsf: 3, prs: [1, 1.5, 2, 3],
    world: { x: 40, y: 300, w: 310, h: 300 } },
  { label: 'desktop 1600x900 @ deviceScaleFactor 2  (no touch)',
    w: 1600, h: 900, phone: false, dsf: 2, prs: [1, 1.5, 2],
    world: { x: 640, y: 290, w: 320, h: 320 } },
];

const F = (s, n) => String(s).padEnd(n);
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const spread = (a) => +(Math.max(...a) - Math.min(...a)).toFixed(3);

console.log('# _j26-sharp — sharpness measured on the composited image, not asserted from a setting.');
console.log('# rig: headless Chrome (channel chrome), real WebGL2 ANGLE Metal, Apple M1 Max, 10 cores.');
console.log(`# ?skipIntro&hour=12.5, arrive('${PLACE}'), governor OFF, ONE page load per viewport block.`);
console.log('# 3 captures per row ~700 ms apart; median reported, (spread) beside it.');
console.log('# film grain: ' + (NOGRAIN ? 'OFF (setGrain(0)) — the control for a per-buffer-pixel post pass' : 'ON, as shipped'));
console.log('# edgeW is in OUTPUT PIXELS: how wide one edge is on the surface the eye receives. 1.0 = ideal step.\n');

for (const V of VIEWPORTS) {
  if (ONLY && !V.label.startsWith(ONLY)) continue;
  const l0 = await loadGate(MAXLOAD);
  const logs = [];
  const { page, close } = await boot({ w: V.w, h: V.h, phone: V.phone, dpr: V.dsf, logs, qs: '?skipIntro&hour=12.5' });
  await sleep(5000);
  await page.evaluate((p) => { try { WALLY.debug.arrive(p, true); } catch (e) {} }, PLACE);
  await sleep(6000);
  await page.evaluate(() => WALLY.debug.governor(false));
  /* THE CONFOUNDER. Film grain is a post pass at BUFFER resolution, so
     at pr 3 there is 9x as much of it and it is 3x finer — which lifts
     a mean-|Laplacian| number all by itself, with no scene detail
     behind it. --nograin turns it off (ctx.render.setGrain(0)) so the
     rows are about the scene. edgeW barely moves either way, because
     it reads the top 0.5 % of gradient peaks and grain is not in them;
     that agreement is the reason to trust edgeW over lap. */
  if (NOGRAIN) await page.evaluate(() => WALLY.ctx.render.setGrain(0));
  const env = await page.evaluate(ENVSTATE);

  /* Find a HUD text element in the #ui layer, in CSS px. It is DOM, so
     it is the control: it cannot change with the drawing buffer. */
  const hud = await page.evaluate(() => {
    const root = document.getElementById('ui');
    if (!root) return null;
    let best = null;
    const walk = (el) => {
      for (const c of el.children) {
        const t = (c.textContent || '').trim();
        const r = c.getBoundingClientRect();
        const vis = getComputedStyle(c).visibility !== 'hidden' && getComputedStyle(c).opacity !== '0';
        if (vis && t.length >= 2 && r.width > 30 && r.height > 10 && r.width * r.height < 200000) {
          const score = t.length * Math.min(r.height, 60);
          if (!best || score > best.score) best = { score, text: t.slice(0, 24), tag: c.tagName + '.' + (c.className || ''),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }
        walk(c);
      }
    };
    walk(root);
    return best;
  });

  console.log(`=== ${V.label}`);
  console.log(`    devicePixelRatio ${env.dpr}  tier '${env.tier}'  prMax ${env.pixelRatioMax}  budget ${env.pixelBudget} Mpx  msaa ${env.msaa}`);
  console.log(`    world crop (CSS px) ${JSON.stringify(V.world)}`);
  console.log(`    HUD control: ${hud ? `${hud.tag} "${hud.text}" at ${hud.x},${hud.y} ${hud.w}x${hud.h} CSS px` : 'NONE FOUND — no control this block'}`);

  const rows = [];
  for (const pr of V.prs) {
    const set = await page.evaluate((v) => { WALLY.debug.pixelRatio(v); return WALLY.debug.viewport(); }, pr);
    await sleep(2500);
    const shots = [];
    for (let i = 0; i < 3; i++) {
      const p = join(tmp, `v${V.w}_pr${String(pr).replace('.', '_')}_${i}.png`);
      await page.screenshot({ path: p });
      shots.push(p);
      await sleep(700);
    }
    rows.push({ pr, set, shots });
  }
  /* one python process for the whole block */
  const spec = [];
  for (const r of rows) {
    const crops = {
      world: [Math.round(V.world.x * V.dsf), Math.round(V.world.y * V.dsf), Math.round(V.world.w * V.dsf), Math.round(V.world.h * V.dsf)],
    };
    if (hud) crops.hud = [Math.round(hud.x * V.dsf), Math.round(hud.y * V.dsf), Math.round(hud.w * V.dsf), Math.round(hud.h * V.dsf)];
    for (let i = 0; i < r.shots.length; i++) spec.push([`${r.pr}#${i}`, r.shots[i], crops]);
  }
  await writeFile(join(tmp, 'spec.json'), JSON.stringify(spec));
  const res = JSON.parse(execSync(`python3 ${join(tmp, 'm.py')} ${join(tmp, 'spec.json')}`, { maxBuffer: 1 << 26 }).toString());
  const l1 = load1();

  console.log('    ' + F('pinned', 8) + F('buffer', 12) + F('Mpx', 7) + F('surface', 12) + '| WORLD CROP: ' +
    F('lap', 16) + F('edgeW', 16) + F('p99dx', 15) + F('hf', 14) + '| HUD (control): ' + F('lap', 14) + 'edgeW');
  let base = null;
  for (const r of rows) {
    const keys = [0, 1, 2].map(i => `${r.pr}#${i}`);
    const pick = (crop, k) => keys.map(kk => res[kk][crop] && res[kk][crop][k]).filter(v => v != null && !Number.isNaN(v));
    const w = { lap: pick('world', 'lap'), edgeW: pick('world', 'edgeW'), p99: pick('world', 'p99dx'), hf: pick('world', 'hf') };
    const hu = hud ? { lap: pick('hud', 'lap'), edgeW: pick('hud', 'edgeW') } : null;
    const surface = res[keys[0]].size.join('x');
    const buf = `${r.set.buffer[0]}x${r.set.buffer[1]}`;
    const mpx = ((r.set.buffer[0] * r.set.buffer[1]) / 1e6).toFixed(3);
    const cell = (a) => `${med(a).toFixed(a[0] < 1 ? 5 : 3)} (${spread(a)})`;
    if (!base) base = { lap: med(w.lap), edgeW: med(w.edgeW), hf: med(w.hf) };
    console.log('    ' + F(r.pr, 8) + F(buf, 12) + F(mpx, 7) + F(surface, 12) + '| ' + ' '.repeat(12) +
      F(cell(w.lap), 16) + F(cell(w.edgeW), 16) + F(cell(w.p99), 15) + F(cell(w.hf), 14) +
      '| ' + ' '.repeat(15) + (hu ? F(cell(hu.lap), 14) + cell(hu.edgeW) : '(no control)'));
  }
  console.log(`    load before ${l0} -> after ${l1};  page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}`);
  if (KEEP) { for (const r of rows) execSync(`cp ${r.shots[0]} ${join(KEEP, `${V.w}x${V.h}_pr${String(r.pr).replace('.', '_')}.png`)}`); }
  console.log('');
  await page.evaluate(() => WALLY.debug.pixelRatio(null));
  await close();
}
console.log(`# PNGs: ${KEEP || tmp}`);
console.log(`# load (1-min) at end: ${load1()}`);
