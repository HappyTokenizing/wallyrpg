#!/usr/bin/env node
/* ============================================================
   _k28-acuity.mjs — EDGE ACUITY PER OPTION, WITH THE CONTROL IN
   THE SAME PNG.

   _j26-sharp measured edge smear across the RESOLUTION axis and put
   its control group inside the delivered image: the HUD is DOM+SVG on
   the #ui layer, composited at deviceScaleFactor no matter what the
   drawing buffer is doing, so it MUST hold flat while the world crop
   moves. It never swept the MSAA axis, because it was written before
   msaa was switchable live.

   This file is that rig with the second axis added. Every row is one
   (pixelRatio x msaa) pair, live-switched on ONE page load, so the
   world, the compiled programs, the streamed foliage and the GPU
   clock are shared across the whole block and the ONLY thing that
   moves is the surface being asked for.

   WHAT edgeW IS AND WHAT IT IS NOT. It is a LENGTH: how many OUTPUT
   pixels one strong edge is smeared across on the composited PNG the
   eye receives. 1.0 is an ideal step. It ranks the resolution axis
   honestly and it RANKS THE MSAA AXIS BACKWARDS — an aliased step is
   one pixel wide and scores beautifully while looking like a flight
   of stairs. Both facts are printed with every table so no row can be
   read as the wrong claim. The MSAA axis is scored by RMSE against a
   supersampled ground truth in _k27-ref.mjs; this file's job on that
   axis is only to show that edgeW does NOT move with samples, which
   is the evidence that the resolution win is not an artefact of the
   metric.

   THE CONTROL. HUD lap/edgeW are printed on every row. If they move
   with the drawing buffer, the rig is measuring its own screenshot
   pipeline and the block is void.

   THE DRIFT ROW. The first combination is measured again at the end
   of each block, marked *. If it disagrees with its own first row,
   everything between them is contaminated by the box.

   ------------------------------------------------------------
   --place TAKES A LOCATION ID AND DIES ON ANYTHING ELSE.

   This rig shipped with `--place mainstreet` as its default and
   `arrive()` wrapped in a try/catch that turned a false into the
   string 'FALSE — boot position' printed in the header. 'mainstreet'
   is a ZONE, not a location: arrivalPoint() returns null for it and
   ui.js's arrive() returns false, so EVERY number this file has
   published was taken at the boot position in the grass under a
   header that named Main Street. That is the third instance of the
   same defect on this project (contracts.js rule 5), and the first
   two were found the same way — by someone standing where the rig
   said it was standing and seeing something else.

   So, matching tools/_k29-crawl.mjs §4: a place that is not exactly
   `arrive(...) === true` is a hard exit with a non-zero code, and the
   camera's OWN account of itself — eye position, the ground height
   under it, height above ground, and the zone the terrain says it is
   in — is printed beside every table. A number without a position is
   not a measurement.

   THE DEFAULT IS NOW `cafe`, the Bent Spoon doorstep, because that is
   where the rest of this family stands (_k27-ref, _k27-cost,
   _k29-crawl, _k30-inv) and a figure that cannot be put beside theirs
   is a figure on its own.

   AND THE HEADLINE FIGURE IS DERIVED HERE, NOT BY HAND. `% of
   available` is printed by the rig with its own formula and its own
   three edgeW values beside it, so it cannot drift from the table it
   is drawn from.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);
/* `--place boot` is the ONE non-location this file accepts, and it is
   accepted so the position defect can be A/B'd rather than quoted: it
   is where the rig used to stand when `--place mainstreet` failed
   silently. It moves nothing and prints BOOT beside every table. */
const PLACE = arg('place', 'cafe');
const MAXLOAD = +arg('maxload', 5);
const KEEP = arg('keep', null);
const ONLY = arg('only', null);
const SHOTS = +arg('shots', 3);
/* The character is not the subject — the world's edges are — and on a
   phone he fills most of the frame. `--wally` keeps him in, which is
   what every figure this rig published before today was measured with. */
const KEEPWALLY = has('wally');

const tmp = await mkdtemp(join(tmpdir(), 'k28acu-'));
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
    n = min(1024, a.shape[0], a.shape[1]); n -= n % 2
    y0 = (a.shape[0]-n)//2; x0 = (a.shape[1]-n)//2
    c = a[y0:y0+n, x0:x0+n]
    win = np.outer(np.hanning(n), np.hanning(n))
    F = np.fft.fftshift(np.abs(np.fft.fft2((c - c.mean())*win)))**2
    yy, xx = np.mgrid[0:n, 0:n]
    r = np.sqrt((yy-n/2)**2 + (xx-n/2)**2) / (n/2) * 0.5
    tot = F[r <= 0.5].sum()
    hf = float(F[(r > 0.2) & (r <= 0.5)].sum() / tot) if tot > 0 else float('nan')
    return dict(lap=round(lapm,4), edgeW=round(edgeW,3), nEdge=len(widths),
                p99dx=round(p99,3), hf=round(hf,5))

out = {}
spec = json.load(open(sys.argv[1]))
for name, path, crops in spec:
    a = np.asarray(Image.open(path).convert('L'))
    row = {'size': [a.shape[1], a.shape[0]]}
    for cn, (x, y, w, h) in crops.items():
        row[cn] = metrics(a[y:y+h, x:x+w])
    out[name] = row
print(json.dumps(out))
`;
await writeFile(join(tmp, 'm.py'), PY);

/* Combos chosen so every option in the decision is a row, plus the
   corners the brief names literally (ratio 2 with 2 and with 0
   samples), plus the point each viewport's budget ACTUALLY lands on. */
const VIEWPORTS = [
  { label: 'desktop 1600x900 @ deviceScaleFactor 2 (no touch, tier high)',
    w: 1600, h: 900, phone: false, dsf: 2,
    world: { x: 640, y: 290, w: 320, h: 320 },
    combos: [[1, 4], [1, 2], [1, 0], [1.264, 2], [1.264, 0], [1.264, 4], [1.5, 2], [2, 2], [2, 0]] },
  { label: 'phone   390x844  @ deviceScaleFactor 3 (touch + mobile UA, tier med)',
    w: 390, h: 844, phone: true, dsf: 3,
    world: { x: 40, y: 300, w: 310, h: 300 },
    combos: [[1, 0], [1, 4], [2, 0], [2, 2], [2, 4], [3, 0]] },
];

const F = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const spread = (a) => +(Math.max(...a) - Math.min(...a)).toFixed(3);

console.log('# _k28-acuity — edge acuity per (pixelRatio x msaa) option, measured on the composited PNG.');
console.log('# rig: headless Chrome (channel chrome), real WebGL2 ANGLE Metal, Apple M1 Max (32-core GPU), 10 CPU cores.');
console.log(`# ?skipIntro&hour=12.5, place '${PLACE}'${PLACE === 'boot' ? ' (the OLD stand — no arrive() at all)' : " via arrive(), asserted TRUE or the run dies"}, governor OFF,`);
console.log(`#   ONE page load per viewport block, ratio+samples live-switched, character ${KEEPWALLY ? 'LEFT IN' : 'HIDDEN'}.`);
console.log(`# ${SHOTS} captures per row ~700 ms apart; median reported, (spread) beside it. Row marked * = first combo re-measured last.`);
console.log('# edgeW is in OUTPUT PIXELS: how wide one edge is on the surface the eye receives. 1.0 = ideal step.');
console.log('# edgeW RANKS MSAA BACKWARDS BY CONSTRUCTION (an aliased step is 1 px wide). Read it down the ratio axis only.');
console.log('# HUD columns are the CONTROL: DOM+SVG composited at dsf. They must NOT move with the drawing buffer.\n');

for (const V of VIEWPORTS) {
  if (ONLY && !V.label.startsWith(ONLY)) continue;
  const l0 = await loadGate(MAXLOAD);
  const logs = [];
  const { page, close } = await boot({ w: V.w, h: V.h, phone: V.phone, dpr: V.dsf, logs, qs: '?skipIntro&hour=12.5' });
  await sleep(5000);
  /* A BAD PLACE IS A HARD EXIT, NOT A CAUGHT FALSE. See the header. */
  if (PLACE !== 'boot') {
    let arrived;
    try { arrived = await page.evaluate((p) => WALLY.debug.arrive(p, true), PLACE); }
    catch (e) { arrived = 'threw: ' + e.message; }
    if (arrived !== true) {
      console.error(`FATAL: arrive('${PLACE}') returned ${JSON.stringify(arrived)}. That is not a location id ` +
        `(a ZONE is not a location), or the world is not ready. Refusing to measure the boot position.`);
      await close(); process.exit(3);
    }
  }
  await sleep(6000);
  await page.evaluate(() => WALLY.debug.governor(false));
  const env = await page.evaluate(ENVSTATE);
  const maxS = await page.evaluate(() => { const g = WALLY.ctx.renderer.getContext(); return g.getParameter(g.MAX_SAMPLES) | 0; });
  const ceil0 = await page.evaluate(() => WALLY.debug.viewport().prCeiling);

  const hud = await page.evaluate(() => {
    const root = document.getElementById('ui');
    if (!root) return null;
    let best = null;
    const walk = (el) => {
      for (const c of el.children) {
        const t = (c.textContent || '').trim();
        const r = c.getBoundingClientRect();
        const st = getComputedStyle(c);
        const vis = st.visibility !== 'hidden' && st.opacity !== '0';
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

  /* WHERE THE CAMERA ACTUALLY IS. Not "which place did we ask for":
     the eye's world position, the ground under it, its height above
     that ground, and the zone the terrain itself reports. This is the
     line that would have caught three rounds of this defect. */
  const at = await page.evaluate(() => {
    const c = WALLY.ctx.camera, d = new WALLY.THREE.Vector3(); c.getWorldDirection(d);
    const g = WALLY.debug.worldHeight(c.position.x, c.position.z);
    const w = WALLY.ctx.wally.position;
    const gw = WALLY.debug.worldHeight(w.x, w.z);
    return {
      eye: c.position.toArray().map(v => +v.toFixed(2)), dir: d.toArray().map(v => +v.toFixed(3)),
      ground: g.y, agl: +(c.position.y - g.y).toFixed(2), zone: g.zone,
      wally: w.toArray().map(v => +v.toFixed(2)), wallyZone: gw.zone, wallyGround: gw.y,
      loc: WALLY.ctx.game?.state?.loc ?? null,
    };
  });

  /* ------------------------------------------------------------
     WHAT IS ACTUALLY INSIDE THE CROP CALLED 'world'.

     The header has always called it the world crop. On a phone at a
     doorstep it is mostly the PLAYER CHARACTER: a matte clay head at
     point-blank range, whose edges are his sunglasses, not the
     roofline the trade was argued over. So the crop is censused
     rather than assumed — one frame with him, one without, and the
     share of crop pixels that move between them is his share of it.
     Same idea as the HUD control: name the subject, do not assume it.
     ------------------------------------------------------------ */
  const censusA = join(tmp, `census_on_${V.w}.png`);
  const censusB = join(tmp, `census_off_${V.w}.png`);
  await page.screenshot({ path: censusA });
  await page.evaluate(() => { WALLY.ctx.wally.root.visible = false; });
  await sleep(600);
  await page.screenshot({ path: censusB });
  await page.evaluate((keep) => { WALLY.ctx.wally.root.visible = keep; }, KEEPWALLY);
  await sleep(600);
  const cropPx = [Math.round(V.world.x * V.dsf), Math.round(V.world.y * V.dsf),
    Math.round(V.world.w * V.dsf), Math.round(V.world.h * V.dsf)];
  const census = +execSync(`python3 -c "
import sys,numpy as np
from PIL import Image
x,y,w,h = ${cropPx.join(',')}
a=np.asarray(Image.open('${censusA}').convert('L')).astype(np.int16)[y:y+h, x:x+w]
b=np.asarray(Image.open('${censusB}').convert('L')).astype(np.int16)[y:y+h, x:x+w]
print(round(float((np.abs(a-b)>6).mean())*100,1))
"`).toString().trim();

  console.log(`=== ${V.label}`);
  console.log(`    devicePixelRatio ${env.dpr}  tier '${env.tier}'  tier msaa ${env.msaa}  MAX_SAMPLES ${maxS}  prMax ${env.pixelRatioMax}  budget ${env.pixelBudget} Mpx  ceiling here ${ceil0}`);
  console.log(`    ${PLACE === 'boot' ? "PLACE 'boot' — NOT a location: the position the rig used to shoot while its header said Main Street"
    : `arrive('${PLACE}') TRUE`}   game loc '${at.loc}'   crop (CSS px) ${JSON.stringify(V.world)}`);
  console.log(`    CROP CENSUS: ${census} % of it is the player character (measured, one frame with him and one without).` +
    `  Character ${KEEPWALLY ? 'LEFT IN' : 'HIDDEN'} for the measurement.`);
  console.log(`    STANDING AT: eye ${JSON.stringify(at.eye)}  dir ${JSON.stringify(at.dir)}  ground ${at.ground} m  eye-above-ground ${at.agl} m  zone '${at.zone}'`);
  console.log(`                 wally ${JSON.stringify(at.wally)}  ground ${at.wallyGround} m  zone '${at.wallyZone}'`);
  console.log(`    HUD control: ${hud ? `${hud.tag} "${hud.text}" at ${hud.x},${hud.y} ${hud.w}x${hud.h} CSS px` : 'NONE FOUND — no control this block'}`);

  const plan = V.combos.concat([V.combos[0]]);
  const rows = [];
  for (let ci = 0; ci < plan.length; ci++) {
    const [pr, ms] = plan[ci];
    const set = await page.evaluate(([p, m]) => {
      WALLY.debug.pixelRatio(p);
      const got = WALLY.debug.msaa(m);
      return { got, vp: WALLY.debug.viewport() };
    }, [pr, ms]);
    await sleep(2500);
    const shots = [];
    for (let i = 0; i < SHOTS; i++) {
      const p = join(tmp, `v${V.w}_pr${String(pr).replace('.', '_')}_ms${ms}_${ci}_${i}.png`);
      await page.screenshot({ path: p });
      shots.push(p);
      await sleep(700);
    }
    rows.push({ pr, ms, set, shots, drift: ci === plan.length - 1, key: `${ci}:${pr}x${ms}` });
  }

  const spec = [];
  for (const r of rows) {
    const crops = { world: [Math.round(V.world.x * V.dsf), Math.round(V.world.y * V.dsf), Math.round(V.world.w * V.dsf), Math.round(V.world.h * V.dsf)] };
    if (hud) crops.hud = [Math.round(hud.x * V.dsf), Math.round(hud.y * V.dsf), Math.round(hud.w * V.dsf), Math.round(hud.h * V.dsf)];
    for (let i = 0; i < r.shots.length; i++) spec.push([`${r.key}#${i}`, r.shots[i], crops]);
  }
  await writeFile(join(tmp, `spec${V.w}.json`), JSON.stringify(spec));
  const res = JSON.parse(execSync(`python3 ${join(tmp, 'm.py')} ${join(tmp, `spec${V.w}.json`)}`, { maxBuffer: 1 << 26 }).toString());
  const l1 = load1();

  console.log('    ' + F('pr', 8) + F('msaa', 6) + F('buffer', 12) + F('Mpx', 7) + F('surface', 12) +
    '| WORLD: ' + F('lap', 16) + F('edgeW', 16) + F('p99dx', 15) + F('hf', 13) + '| HUD CONTROL: ' + F('lap', 15) + 'edgeW');
  for (const r of rows) {
    const keys = Array.from({ length: SHOTS }, (_, i) => `${r.key}#${i}`);
    const pick = (crop, k) => keys.map(kk => res[kk][crop] && res[kk][crop][k]).filter(v => v != null && !Number.isNaN(v));
    const w = { lap: pick('world', 'lap'), edgeW: pick('world', 'edgeW'), p99: pick('world', 'p99dx'), hf: pick('world', 'hf') };
    const hu = hud ? { lap: pick('hud', 'lap'), edgeW: pick('hud', 'edgeW') } : null;
    const cell = (a) => `${med(a).toFixed(a[0] < 1 ? 5 : 3)} (${spread(a)})`;
    console.log('    ' + F(r.pr + (r.drift ? '*' : ''), 8) + F(r.set.got.samples, 6) +
      F(`${r.set.vp.buffer[0]}x${r.set.vp.buffer[1]}`, 12) + F(((r.set.vp.buffer[0] * r.set.vp.buffer[1]) / 1e6).toFixed(3), 7) +
      F(res[keys[0]].size.join('x'), 12) + '| ' + ' '.repeat(7) +
      F(cell(w.lap), 16) + F(cell(w.edgeW), 16) + F(cell(w.p99), 15) + F(cell(w.hf), 13) +
      '| ' + ' '.repeat(13) + (hu ? F(cell(hu.lap), 15) + cell(hu.edgeW) : '(no control)'));
  }
  /* ------------------------------------------------------------
     THE HEADLINE FIGURE, DERIVED HERE RATHER THAN BY HAND.

     "x % of available" is the share of the resolution axis's whole
     edge-acuity range that the ratio this viewport SHIPS at has
     actually taken:

         (edgeW@floor - edgeW@ship) / (edgeW@floor - edgeW@ceiling)

     msaa is held at the tier's own sample count down all three rows,
     so the only thing moving is the ratio — edgeW ranks the sample
     axis backwards and must never be read across it. floor is the
     ratio every tier still boots at (1); ceiling is the highest ratio
     this block measured; ship is the ratio the tier's ceiling allows
     the governor to climb to here. All three edgeW values are printed
     beside the percentage so it can be re-derived from the table.
     ------------------------------------------------------------ */
  const tierMs = env.msaa | 0;
  const edgeAt = (pr) => {
    const r = rows.find(x => !x.drift && x.pr === pr && (x.set.got.samples | 0) === tierMs);
    if (!r) return null;
    const keys = Array.from({ length: SHOTS }, (_, i) => `${r.key}#${i}`);
    const v = keys.map(k => res[k].world && res[k].world.edgeW).filter(x => x != null && !Number.isNaN(x));
    return v.length ? med(v) : null;
  };
  const ratios = rows.filter(r => !r.drift && (r.set.got.samples | 0) === tierMs).map(r => r.pr).sort((a, b) => a - b);
  const shipPr = ratios.filter(p => p <= (ceil0 + 1e-6)).pop();
  if (ratios.length >= 2 && shipPr != null) {
    const lo = ratios[0], hi = ratios[ratios.length - 1];
    const a = edgeAt(lo), b = edgeAt(shipPr), c = edgeAt(hi);
    if (a != null && b != null && c != null && Math.abs(a - c) > 1e-9) {
      const pct = ((a - b) / (a - c)) * 100;
      console.log(`    ACUITY GAIN at msaa ${tierMs}: edgeW ${a.toFixed(3)} @pr ${lo}  ->  ${b.toFixed(3)} @pr ${shipPr} (ships, ceiling ${ceil0})` +
        `  ->  ${c.toFixed(3)} @pr ${hi} (highest measured)`);
      console.log(`      = ${pct.toFixed(1)} % of available  [(${a.toFixed(3)} - ${b.toFixed(3)}) / (${a.toFixed(3)} - ${c.toFixed(3)})]` +
        `   taken at eye ${JSON.stringify(at.eye)}, zone '${at.zone}', place '${PLACE}', character ${KEEPWALLY ? 'in' : 'hidden'}`);
    } else {
      console.log(`    ACUITY GAIN: not derivable — need pr ${lo}/${shipPr}/${hi} rows at msaa ${tierMs}`);
    }
  }
  console.log(`    load before ${l0} -> after ${l1};  page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}`);
  if (KEEP) for (const r of rows) if (!r.drift) execSync(`cp ${r.shots[0]} ${join(KEEP, `${V.w}x${V.h}_pr${String(r.pr).replace('.', '_')}_ms${r.set.got.samples}.png`)}`);
  console.log('');
  await page.evaluate(() => WALLY.debug.pixelRatio(null));
  await close();
}
console.log(`# PNGs: ${KEEP || tmp}`);
console.log(`# load (1-min) at end: ${load1()}`);
