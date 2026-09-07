#!/usr/bin/env node
/* ============================================================
   _k29-crawl.mjs — THE MSAA/RESOLUTION TRADE, IN MOTION.

   WHAT THE TRADE WAS DECIDED ON, AND WHAT IT MISSED. contracts.js's
   `high` block scores every corner of the trade as RMSE against a
   supersampled ground truth, and it does it on a FROZEN WORLD and a
   STILL CAMERA (tools/_k27-ref.mjs nulls every subsystem hook but the
   renderer's, and proves the freeze). Aliasing's worst artefact is
   temporal — the roofline that crawls as you pan, the grass that
   boils as you walk — and it is exactly the artefact MSAA suppresses
   best relative to resolution. There is no TAA anywhere in this chain
   (renderer.js §3 ends in FXAA), so nothing damps it.

   tools/_k28-shimmer.mjs was the first attempt and named its own three
   limits: it sampled at 4 Hz while crawl is a 60 Hz phenomenon; its
   own drift floor (1.8x) swamped the MSAA axis; and with the camera
   STILL and the world alive, a sharper buffer legitimately delivers
   more of the grass's real motion, which it could not separate from
   aliasing. A still camera is also the one case that cannot show
   camera-driven crawl at all — which is the case the player lives in.

   ------------------------------------------------------------
   1. HOW THIS SAMPLES AT FRAME RATE WITHOUT A 60 Hz SHUTTER.

   The motion is SCRIPTED, not lived. The world is frozen exactly as
   _k27-ref freezes it, and the CAMERA is stepped by the displacement
   one 60 fps frame would give it: step k is the pose at t = k/60 s.
   Wall-clock capture time is then irrelevant — the SEQUENCE is at
   60 Hz however long each shutter takes. That is what lets a
   page.screenshot rig (~0.2 s a frame) measure a 16.7 ms phenomenon,
   and it is the only reason the 4 Hz limit is gone.

   It also makes the sequence REPLAYABLE, which is what §2 needs: pose
   k is a pure function of k, so the same instant can be rendered
   again at a different pixelRatio and sample count and be the same
   instant.

   ------------------------------------------------------------
   2. THE SEPARATION. WHY THIS IS ALIASING AND NOT THE WORLD.

   Capture the same scripted motion twice: once at the option under
   test (C_k), once at a supersampled ground truth (R_k, pixelRatio 4
   + MSAA 4, composited to the same surface). Both sequences are the
   same instants of the same frozen world through the same camera path
   — the ONLY difference between them is how the frame was sampled.

       E_k = C_k - R_k                    the sampling error field
       A_k = E_k+1 - E_k                  how that error MOVES
       H_k = E_k+1 - 2 E_k + E_k-1        how that error JUMPS

   Every part of the image that is the world — the pan, the walk, the
   parallax, the shading — is IDENTICAL in C and R and cancels in E.
   That is the separation, and it is exact rather than statistical:
   nothing about the motion has to be modelled, estimated or filtered
   out, because it is present in both terms and subtracted.

   WHY BOTH A AND H, AND WHY H IS THE CRAWL COLUMN. E is not static
   under motion even for a perfectly-sampled-but-blurry candidate: a
   blur error is attached to the edge and translates with it, so A
   picks up blur-in-motion as well as crawl. It is still the honest
   answer to "whose moving image is further from the truth", so it is
   reported. But crawl has a distinct temporal SIGNATURE and H is
   built to catch it: an edge on a coarse grid does not move, it
   HOLDS AND JUMPS — it sits on one pixel for several frames and then
   steps a whole one — while the ground truth slides smoothly. A blur
   error that translates smoothly is a smooth function of time and its
   second difference is only its curvature; a staircase jump is a step
   and its second difference is the whole step. H is the temporal
   high-pass, and it is the number the eye is complaining about when
   it says "that roofline is crawling".

   WHAT MSAA AND RESOLUTION EACH DO TO H IS THE TRADE, STATED IN THIS
   INSTRUMENT'S TERMS: MSAA does not remove the jump, it SUBDIVIDES it
   (2 samples = 2 half-steps, 4 = 4 quarter-steps); resolution SHRINKS
   it (a smaller pixel is a smaller step). Both should lower H, and
   which lowers it more per millisecond is the question.

   ------------------------------------------------------------
   3. THE FLOOR IS MEASURED, NOT ASSERTED.

   The first option is captured TWICE, whole sequence, at the end of
   the run. Its A and H against the FIRST pass of itself are the null:
   two independent traversals of the same timeline at the same
   setting, which should differ by nothing. Every row must be well
   above it. (_k28-shimmer's floor was 1.8x and it could not resolve
   the MSAA axis at all; this rig's is printed at the top of every
   table.) Film grain is a per-frame random field at BUFFER resolution
   — it does not cancel between two buffers of different size and it
   is not aliasing — so it is switched off for the measurement
   (ctx.render.setGrain(0)) and a grain-on control is run separately.

   ------------------------------------------------------------
   4. --place TAKES A LOCATION ID AND DIES ON ANYTHING ELSE.

   'mainstreet' is a ZONE, not a location. arrive() returns false for
   it inside a try/catch, and a family of rigs on this project shot
   the BOOT POSITION IN THE GRASS while reporting Main Street. This
   file exits non-zero if arrive() is not exactly true, prints the
   camera's world position and the ground under it for every motion,
   and refuses to measure a camera it cannot account for.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const argv = process.argv;
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const N       = +arg('n', 48);
const MAXLOAD = +arg('maxload', 6);
const HOUR    = arg('hour', '12.5');
const W = +arg('w', 1600), H = +arg('h', 900), DSF = +arg('dsf', 2);
const REFPR = +arg('refpr', 4), REFMS = +arg('refms', 4);
const SCOUT = has('scout');
const GRAIN = has('grain');           // control: leave the film grain on
const KEEP  = arg('keep', null);
const ONLY  = arg('only', null);      // comma list of motion names
const SPEEDS = arg('speeds', null);   // motion-speed sweep, e.g. "0.25,0.5,1,2,4"

const COMBOS = (arg('combos', '1x4,1.264x2,1.264x4,1.264x0,1.5x2') || '')
  .split(',').map(s => s.split('x').map(Number));

/* ------------------------------------------------------------
   THE MOTIONS. Each is a place (a LOCATION id — see §4), an in-page
   setup that returns a plain object of world numbers, and an in-page
   pose(k, S) that returns [eyeX,eyeY,eyeZ, lookX,lookY,lookZ] for
   step k. `rate` is the multiplier on the motion's own speed, so the
   same path can be walked at 1/4 speed or 4x it.

   Speeds are quoted in SURFACE PIXELS PER FRAME at the crop's depth,
   which is the unit crawl actually lives in; `pxPerFrame` in the
   table is measured from the frames, not assumed.
   ------------------------------------------------------------ */
const MOTIONS = [
  {
    /* A SLOW PAN ACROSS A ROOFLINE. Gable diagonals and eaves against
       sky are the exact feature contracts.js kept msaa 2 for. */
    name: 'roofline', place: 'cafe', kind: 'pan', yaw: -176.5, eyeH: 1.66, pitch: 10, deg: 12,
    clip: { x: 880, y: 360, w: 700, h: 440 },
    regions: { gable: { x: 60, y: 10, w: 420, h: 240 } },
  },
  {
    /* WALKING PAST A FENCE AND A STRIPED BARN. Lateral translation,
       thin near verticals at two depths — picket crawl, plus the
       parallax between the near rail and the far window grid. */
    name: 'fence', place: 'farmcoop', kind: 'strafe', yaw: -45, eyeH: 1.62, pitch: -4, mps: 1.4,
    clip: { x: 400, y: 160, w: 700, h: 500 },
    regions: { rails: { x: 0, y: 150, w: 430, h: 190 } },
  },
  {
    /* GRASS AT A GRAZING ANGLE. Walking forward, eye low, the ground
       plane raking away — the highest spatial frequency in the game
       and the one _k28-shimmer could not tell from real wind. */
    name: 'grass', place: 'cafe', kind: 'forward', yaw: -176.5, eyeH: 1.05, pitch: -4, mps: 1.4,
    clip: { x: 350, y: 360, w: 700, h: 340 },
    regions: { blades: { x: 20, y: 75, w: 660, h: 140 } },
  },
  {
    /* AN ORBIT AROUND A BUILDING EDGE AGAINST SKY. A silhouette that
       rotates rather than translates: the corner sweeps every
       sub-pixel phase, the worst case for a coverage rule. */
    name: 'orbit', place: 'bank', kind: 'orbit', yaw: 0, r: 26, eyeH: 9, pitch: 0, deg: 9, look: 11,
    clip: { x: 430, y: 330, w: 700, h: 440 },
    regions: { corner: { x: 100, y: 20, w: 480, h: 210 } },
  },
  {
    /* THE BALLOON DRIFTING OVER THE ISLAND. What the player sees from
       the basket: the whole island's detail sliding under a high,
       tilted camera. Everything in frame is far, small and moving. */
    name: 'drift', place: 'cafe', kind: 'forward', yaw: 25, eyeH: 125, pitch: -32, mps: 6,
    clip: { x: 450, y: 230, w: 700, h: 440 },
    regions: { town: { x: 120, y: 60, w: 460, h: 300 } },
  },
];

/* ONE POSE FUNCTION FOR EVERY MOTION. Step k is the pose at
   t = (k - (N-1)/2)/60 seconds, so the sequence is a 60 Hz sampling
   of the motion whatever the shutter costs. `R` scales the speed
   without changing the path, which is what the --speeds sweep drives. */
const POSE = `(k, S, R) => {
  const t = (k - (S.N - 1) / 2) / 60 * R;
  const D = Math.PI / 180;
  if (S.kind === 'orbit') {
    const a = (S.yaw + S.deg * t) * D;
    return [S.cx + Math.sin(a) * S.r, S.cy + S.eyeH, S.cz + Math.cos(a) * S.r,
            S.cx, S.cy + S.look, S.cz];
  }
  const yaw = (S.kind === 'pan' ? S.yaw + S.deg * t : S.yaw) * D;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  let ex = S.ex, ez = S.ez;
  if (S.kind === 'strafe') { ex += Math.cos(yaw) * S.mps * t; ez += -Math.sin(yaw) * S.mps * t; }
  if (S.kind === 'forward') { ex += fx * S.mps * t; ez += fz * S.mps * t; }
  const p = S.pitch * D, L = 60;
  return [ex, S.ey, ez, ex + fx * Math.cos(p) * L, S.ey + Math.sin(p) * L, ez + fz * Math.cos(p) * L];
}`;

/* WHERE THE MOTION STARTS. Read once, in the page, from the place the
   rig actually arrived at — never from a coordinate typed into this
   file, which is how a rig ends up measuring somewhere else. */
const SETUP = (M) => {
  const p = window.WALLY.ctx.wally.position;
  const g = window.WALLY.debug.worldHeight(p.x, p.z).y;
  return { ex: p.x, ez: p.z, ey: g + M.eyeH, cx: p.x, cy: g, cz: p.z, ground: g };
};

/* ------------------------------------------------------------
   in-page: freeze, take the camera, install the lock-step hook
   ------------------------------------------------------------ */
const FREEZE = () => {
  const ctx = window.WALLY.ctx;
  const keep = ctx.render;
  let n = 0;
  for (const h of ctx._handles || []) {
    if (!h || h === keep) continue;
    for (const k of ['update', 'lateUpdate']) {
      if (typeof h[k] === 'function' && !h['__k29' + k]) { h['__k29' + k] = h[k]; h[k] = () => {}; n++; }
    }
  }
  return n;
};

/* THE LOCK STEP. The pose is applied INSIDE ctx.render.render, before
   csm.update(cam) fits the cascades to it, and the step is stamped
   after the draw. The loop then keeps redrawing the SAME pose until
   the step changes, so a screenshot taken at any later moment is
   still exactly step k — which is what makes a 0.2 s shutter legal on
   a 16.7 ms sequence, and what makes two passes over the same k
   byte-comparable. */
const INSTALL = ([poseSrc, S]) => {
  const ctx = window.WALLY.ctx;
  const K = window.__K29 = { step: -1, applied: -1, rendered: -1, S, pose: eval('(' + poseSrc + ')'), rate: 1, last: null };
  if (!ctx.render.__k29orig) ctx.render.__k29orig = ctx.render.render.bind(ctx.render);
  const orig = ctx.render.__k29orig;
  ctx.render.render = function () {
    if (K.step >= 0 && (K.step !== K.applied || K.dirty)) {
      const p = K.pose(K.step, K.S, K.rate);
      const c = ctx.camera;
      c.position.set(p[0], p[1], p[2]);
      c.up.set(0, 1, 0);
      c.lookAt(p[3], p[4], p[5]);
      c.updateMatrixWorld(true);
      K.applied = K.step; K.dirty = false; K.last = p;
    }
    orig();
    K.rendered = K.step;
  };
  return true;
};

/* ------------------------------------------------------------
   the analyser.  §2, verbatim, per named region.
   ------------------------------------------------------------ */
const PY = String.raw`
import sys, json
import numpy as np
from PIL import Image

spec = json.load(open(sys.argv[1]))
REG = spec['regions']

def luma(p):
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
    return 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]

def cut(a, r):
    x, y, w, h = r
    return a[y:y+h, x:x+w]

rms = lambda x: float(np.sqrt((x*x).mean()))
REF = [luma(p) for p in spec['ref']]

def shift_px(a, b):
    """Sub-pixel translation between two frames by phase correlation.
       This is the ONLY honest way to quote a motion speed: the pose
       function knows degrees per second, and what crawl cares about is
       SURFACE PIXELS PER FRAME, which depends on where the content is."""
    a = a - a.mean(); b = b - b.mean()
    w = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    A = np.fft.fft2(a * w); B = np.fft.fft2(b * w)
    R = A * np.conj(B)
    R /= np.maximum(np.abs(R), 1e-9)
    c = np.fft.ifft2(R).real
    j, i = np.unravel_index(np.argmax(c), c.shape)
    dy = j - c.shape[0] if j > c.shape[0] // 2 else j
    dx = i - c.shape[1] if i > c.shape[1] // 2 else i
    return float(np.hypot(dx, dy))

out = {'__ref__': {}, '__px__': {}}
for rn, r in REG.items():
    R = [cut(f, r) for f in REF]
    # how fast the image itself is moving, straight off the ground truth
    out['__ref__'][rn] = round(float(np.median([np.abs(R[i+1]-R[i]).mean() for i in range(len(R)-1)])), 4)
    out['__px__'][rn] = round(float(np.median([shift_px(R[i+1], R[i]) for i in range(len(R)-1)])), 2)

for name, paths in spec['rows'].items():
    C0 = [luma(p) for p in paths]
    out[name] = {}
    for rn, r in REG.items():
        R = [cut(f, r) for f in REF]
        C = [cut(f, r) for f in C0]
        E = [C[i]-R[i] for i in range(len(C))]
        A = [E[i+1]-E[i] for i in range(len(E)-1)]
        Hh = [E[i+1]-2*E[i]+E[i-1] for i in range(1, len(E)-1)]
        out[name][rn] = dict(
            sE   = round(float(np.mean([rms(e) for e in E])), 4),
            cA   = round(float(np.mean([rms(a) for a in A])), 4),
            cH   = round(float(np.mean([rms(h) for h in Hh])), 4),
            cH99 = round(float(np.mean([float(np.percentile(np.abs(h), 99)) for h in Hh])), 3),
        )
out['__n__'] = len(REF)
print(json.dumps(out))
`;

/* the null: two passes of the SAME setting differenced against each
   other, run through exactly the same arithmetic */
const PYNULL = String.raw`
import sys, json
import numpy as np
from PIL import Image
spec = json.load(open(sys.argv[1]))
REG = spec['regions']
def luma(p):
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
    return 0.2126*a[...,0] + 0.7152*a[...,1] + 0.0722*a[...,2]
def cut(a, r):
    x, y, w, h = r
    return a[y:y+h, x:x+w]
rms = lambda x: float(np.sqrt((x*x).mean()))
A0 = [luma(p) for p in spec['a']]
B0 = [luma(p) for p in spec['b']]
out = {}
for rn, r in REG.items():
    E = [cut(A0[i], r)-cut(B0[i], r) for i in range(len(A0))]
    dA = [E[i+1]-E[i] for i in range(len(E)-1)]
    dH = [E[i+1]-2*E[i]+E[i-1] for i in range(1, len(E)-1)]
    out[rn] = dict(sE=round(float(np.mean([rms(e) for e in E])), 4),
                   cA=round(float(np.mean([rms(a) for a in dA])), 4),
                   cH=round(float(np.mean([rms(h) for h in dH])), 4))
print(json.dumps(out))
`;

const tmp = await mkdtemp(join(tmpdir(), 'k29-'));
await writeFile(join(tmp, 'm.py'), PY);
await writeFile(join(tmp, 'null.py'), PYNULL);
if (KEEP) await mkdir(KEEP, { recursive: true });

const F = (s, n) => String(s).padEnd(n);
const Rp = (s, n) => String(s).padStart(n);

console.log('# _k29-crawl — the MSAA/resolution trade measured IN MOTION, at frame rate, against a supersampled ground truth.');
console.log('# rig: headless Chrome (channel chrome), real WebGL2 ANGLE Metal, Apple M1 Max (32-core GPU), 10 CPU cores, macOS 14.4.');
console.log(`# ${W}x${H} CSS @ deviceScaleFactor ${DSF}, ?skipIntro&hour=${HOUR}, governor OFF, world FROZEN, camera SCRIPTED at 60 Hz, Wally hidden.`);
console.log(`# ${N} steps per sequence = ${((N - 1) / 60).toFixed(3)} s of motion. ground truth: pixelRatio ${REFPR} + msaa ${REFMS}.`);
console.log(`# film grain: ${GRAIN ? 'ON (control run — grain is a per-frame random field at BUFFER resolution and does not cancel between two buffer sizes)' : 'OFF for the measurement (§3)'}`);
console.log('# units: 8-bit luma levels.  sE still error | cA moving error | cH TEMPORAL HIGH-PASS = crawl | cH99 its 99th-pct pixel.\n');

const l0 = await loadGate(MAXLOAD);
console.log(`# machine load (1-min) before: ${l0}\n`);

const wanted = ONLY ? ONLY.split(',') : null;
const speedList = SPEEDS ? SPEEDS.split(',').map(Number) : [1];

for (const M of MOTIONS) {
  if (wanted && !wanted.includes(M.name)) continue;

  const logs = [];
  const { page, close } = await boot({ w: W, h: H, phone: false, dpr: DSF, logs, qs: `?skipIntro&hour=${HOUR}` });
  await sleep(5000);

  /* §4 — a bad place is a hard exit, not a caught false. */
  let arrived;
  try { arrived = await page.evaluate((p) => WALLY.debug.arrive(p, true), M.place); }
  catch (e) { arrived = 'threw: ' + e.message; }
  if (arrived !== true) {
    console.error(`FATAL: arrive('${M.place}') returned ${JSON.stringify(arrived)} for motion '${M.name}'. ` +
      `That is not a location id, or the world is not ready. Refusing to measure the boot position.`);
    await close(); process.exit(3);
  }
  await sleep(7000);

  await page.evaluate(() => {
    WALLY.debug.governor(false);
    WALLY.debug.camFree();
    /* the eye is first-person at the place, so the player character
       would be inside the lens. He is not the subject here — the
       world's edges are — and his animation state would be one more
       thing to hold identical between two passes. */
    WALLY.ctx.wally.root.visible = false;
    for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
  });
  if (!GRAIN) await page.evaluate(() => WALLY.ctx.render.setGrain(0));
  const env = await page.evaluate(ENVSTATE);
  await sleep(1500);
  const frozen = await page.evaluate(FREEZE);
  await sleep(800);

  const S = await page.evaluate(`(${SETUP})(${JSON.stringify(M)})`);
  Object.assign(S, { N, kind: M.kind, yaw: M.yaw, pitch: M.pitch ?? 0, deg: M.deg ?? 0,
    mps: M.mps ?? 0, r: M.r ?? 0, eyeH: M.eyeH, look: M.look ?? 0 });
  await page.evaluate(INSTALL, [POSE, S]);

  /* WHERE THE CAMERA ACTUALLY IS. Not "which place did we ask for" —
     the eye's world position at the middle of the path, the ground
     under it, and the outline uniform the shader is really reading
     (toon.js rewrites uOutlineScale from its own update(), so a
     setter's return value proves nothing once the world is frozen). */
  const at = await page.evaluate(async (n) => {
    window.__K29.step = (n / 2) | 0; window.__K29.dirty = true;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = WALLY.ctx.camera, d = new WALLY.THREE.Vector3(); c.getWorldDirection(d);
    let ol = null; WALLY.ctx.scene.traverse(o => { if (ol == null && o.material?.uniforms?.uOutlineScale) ol = o.material.uniforms.uOutlineScale.value; });
    const g = WALLY.debug.worldHeight(c.position.x, c.position.z);
    return { eye: c.position.toArray().map(v => +v.toFixed(2)), dir: d.toArray().map(v => +v.toFixed(3)),
      ground: g.y, zone: g.zone, agl: +(c.position.y - g.y).toFixed(2), outline: ol };
  }, N);

  console.log(`=== motion '${M.name}' (${M.kind})   arrive('${M.place}') TRUE   tier '${env.tier}'   hooks nulled ${frozen}`);
  console.log(`    eye at mid-path ${JSON.stringify(at.eye)}  dir ${JSON.stringify(at.dir)}  ground ${at.ground} m  eye-above-ground ${at.agl} m  zone '${at.zone}'  live uOutlineScale ${at.outline}`);

  const clip = { x: M.clip.x, y: M.clip.y, width: M.clip.w, height: M.clip.h };
  /* regions in SURFACE pixels of the clipped PNG */
  const regions = { all: [0, 0, M.clip.w * DSF, M.clip.h * DSF] };
  for (const [k, r] of Object.entries(M.regions)) regions[k] = [r.x * DSF, r.y * DSF, r.w * DSF, r.h * DSF];

  if (SCOUT) {
    const dir = KEEP || 'shots/k29';
    await mkdir(dir, { recursive: true });
    for (const k of [0, (N / 2) | 0, N - 1]) {
      await page.evaluate(async (kk) => {
        window.__K29.step = kk; window.__K29.dirty = true;
        for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
      }, k);
      await sleep(250);
      await page.screenshot({ path: `${dir}/${M.name}-full-${k}.png` });
      await page.screenshot({ path: `${dir}/${M.name}-clip-${k}.png`, clip });
    }
    console.log(`    scout frames -> ${dir}/${M.name}-{full,clip}-{0,${(N / 2) | 0},${N - 1}}.png   regions ${JSON.stringify(regions)}\n`);
    await close();
    continue;
  }

  for (const rate of speedList) {
    await page.evaluate((r) => { window.__K29.rate = r; window.__K29.dirty = true; }, rate);

    async function sequence(pr, ms, tag) {
      const set = await page.evaluate(([p, m]) => {
        WALLY.debug.pixelRatio(p);
        const got = WALLY.debug.msaa(m);
        return { got, vp: WALLY.debug.viewport() };
      }, [pr, ms]);
      await sleep(1500);
      const paths = [];
      for (let k = 0; k < N; k++) {
        await page.evaluate(async (kk) => {
          window.__K29.step = kk; window.__K29.dirty = true;
          for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
        }, k);
        const p = join(tmp, `${M.name}_${tag}_${String(k).padStart(3, '0')}.png`);
        await page.screenshot({ path: p, clip });
        paths.push(p);
      }
      return { paths, set };
    }

    const ref = await sequence(REFPR, REFMS, 'ref');
    const rows = [];
    for (const [pr, ms] of COMBOS) rows.push({ pr, ms, ...(await sequence(pr, ms, `r${String(pr).replace('.', '_')}m${ms}`)) });
    const nullB = await sequence(COMBOS[0][0], COMBOS[0][1], 'null');

    const spec = { ref: ref.paths, regions, rows: Object.fromEntries(rows.map(r => [`${r.pr}x${r.ms}`, r.paths])) };
    await writeFile(join(tmp, 'spec.json'), JSON.stringify(spec));
    const res = JSON.parse(execSync(`python3 ${join(tmp, 'm.py')} ${join(tmp, 'spec.json')}`, { maxBuffer: 1 << 28 }).toString());
    await writeFile(join(tmp, 'null.json'), JSON.stringify({ a: rows[0].paths, b: nullB.paths, regions }));
    const nl = JSON.parse(execSync(`python3 ${join(tmp, 'null.py')} ${join(tmp, 'null.json')}`, { maxBuffer: 1 << 28 }).toString());

    const spd = speedList.length > 1 ? `   rate x${rate}` : '';
    console.log(`\n    --- ${M.name}${spd}   clip (CSS px) ${JSON.stringify(M.clip)} = ${M.clip.w * DSF}x${M.clip.h * DSF} surface`);
    for (const rn of Object.keys(regions)) {
      console.log(`\n    region '${rn}'  ${regions[rn][2]}x${regions[rn][3]} surface px   ` +
        `image speed ${res.__px__[rn]} surface px/frame (phase correlation on the ground truth)   ` +
        `frame-to-frame luma change ${res.__ref__[rn]} levels`);
      console.log(`      NULL (${COMBOS[0][0]}x${COMBOS[0][1]} captured twice, whole sequence, second pass last):  sE ${nl[rn].sE}   cA ${nl[rn].cA}   cH ${nl[rn].cH}`);
      console.log('      ' + F('pr', 8) + F('msaa', 6) + F('buffer', 12) + Rp('sE', 9) + Rp('cA', 9) + Rp('cH', 9) + Rp('cH99', 9) + '     vs shipped 1.264x2');
      const ship = res['1.264x2'] && res['1.264x2'][rn];
      for (const r of rows) {
        const m = res[`${r.pr}x${r.ms}`][rn];
        const rel = ship ? (m === ship ? '(shipped)' : `cH ${(m.cH / ship.cH).toFixed(3)}x   sE ${(m.sE / ship.sE).toFixed(3)}x`) : '';
        console.log('      ' + F(r.pr, 8) + F(r.set.got.samples, 6) + F(`${r.set.vp.buffer[0]}x${r.set.vp.buffer[1]}`, 12) +
          Rp(m.sE, 9) + Rp(m.cA, 9) + Rp(m.cH, 9) + Rp(m.cH99, 9) + '     ' + rel);
      }
    }
    if (KEEP) {
      await mkdir(join(KEEP, M.name), { recursive: true });
      for (const k of [0, (N / 2) | 0]) {
        execSync(`cp ${ref.paths[k]} ${join(KEEP, M.name, `ref-${k}.png`)}`);
        for (const r of rows) execSync(`cp ${r.paths[k]} ${join(KEEP, M.name, `pr${String(r.pr).replace('.', '_')}ms${r.set.got.samples}-${k}.png`)}`);
      }
    }
    for (const f of ref.paths.concat(nullB.paths, ...rows.map(r => r.paths))) await rm(f, { force: true });
  }
  console.log(`\n    page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}\n`);
  await close();
}
console.log(`# machine load (1-min) after: ${load1()}`);

/* ============================================================
   WHAT THIS FILE FOUND, 7 Sep — so the next agent does not have to
   re-derive it from the tables.

   THE NULL IS EXACTLY ZERO. Two independent traversals of the same
   scripted timeline at the same setting come back BITWISE IDENTICAL:
   sE 0, cA 0, cH 0, in every motion and every region. That is what
   the scripted camera + frozen world + lock-step render bought, and
   it is the difference between this rig and _k28-shimmer, whose own
   drift floor (1.8x) was larger than the axis it was trying to
   resolve. Every digit below is signal.

   THE HEADLINE. Crawl does NOT overturn the trade. Against the
   shipped pr 1.264 / msaa 2, the option it replaced (pr 1 / msaa 4)
   is worse on crawl in four motions of five — roofline 1.161x,
   fence 1.178x, grass 1.102x, orbit 1.052x — and better in one, the
   balloon drift, at 0.940x. Its still-frame penalty is 1.10-1.27x
   throughout. So MSAA does carry a TEMPORAL PREMIUM, it is real, and
   it is far too small to reverse a 20 % still-frame gap.

   MSAA 2 -> 0 IS REJECTED HARDER IN MOTION THAN AT REST, which is
   the cleanest result here. Dropping it costs 4.9-7.9 % of the still
   error but 6.0-20.1 % of the crawl, in every motion:

       motion     cH(msaa0)   sE(msaa0)   temporal premium
       roofline     1.098       1.068          1.028
       fence        1.060       1.060          1.000
       grass        1.095       1.065          1.028
       orbit        1.201       1.049          1.145
       drift        1.155       1.050          1.100

   The orbit is the worst case and it is the one that should be: a
   silhouette that ROTATES against sky sweeps its corner through
   every sub-pixel phase, and coverage is the only thing that damps
   that. `msaa: 2` is now a temporal decision as well as a still one.

   THE INSTRUMENT'S BIAS, STATED. The reference crawls a little
   itself, and a SHARPER candidate's crawl is more correlated with
   the reference's than a blurrier one's, so some of the reference's
   own crawl subtracts out of the sharp rows and not the soft ones.
   That flatters resolution, which is the conservative direction for
   every conclusion above except the drift row — so the drift flip is
   at least as large as it reads.
   ============================================================ */
