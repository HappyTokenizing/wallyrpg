#!/usr/bin/env node
/* ============================================================
   _k30-judge.mjs — JUDGE'S RE-RUN OF _k29-crawl, WITH THE FRAMES KEPT.

   Same instrument, verbatim where it matters (FREEZE, POSE, INSTALL,
   the arrive() hard-exit), with four differences, each of which exists
   because the judgement needs it:

   1. EVERY FRAME IS WRITTEN TO DISK, including the reference and the
      null pass. _k29 analysed in a temp dir and deleted. A number I
      cannot re-derive from pixels I can look at is a number I am
      taking on trust, and the "by eye, in motion" question can only be
      answered from a sequence.

   2. THE REFERENCE'S OWN BUFFER IS PRINTED. _k29 prints vp.buffer for
      every candidate row and NOT for the ground truth, so nothing in
      its output proves pixelRatio(4) was not silently clamped. It is
      not clamped — maxPixelRatio() returns glClamp(prOverride) and
      bypasses the tier ceiling — but the rig should say so, because a
      clamped reference would make every row in the table a comparison
      against another aliased image.

   3. --rate 0 IS THE NO-MOTION CONTROL. Same code path, same 24
      captures, pose frozen at step N/2. If anything in the frame moves
      on its own — wind in the grass, a cloud, an animated uniform, a
      random film-grain field — cA and cH cannot be zero here, and the
      crawl column is measuring the world instead of the sampling.

   4. --nofreeze IS THE CONFOUND, RUN ON PURPOSE. The world left alive
      while the camera is scripted. This is the state _k28-shimmer
      measured in, and it is what the frozen rows have to be compared
      against before "we separated aliasing from real motion" means
      anything.

   Regions are NOT chosen in this file. Frames are kept and
   tools/_k30-an.py cuts them, so a control region can be picked after
   looking at the pixels rather than guessed before.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv;
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const N       = +arg('n', 24);
const MAXLOAD = +arg('maxload', 6);
const HOUR    = arg('hour', '12.5');
const W = +arg('w', 1600), H = +arg('h', 900), DSF = +arg('dsf', 2);
const REFPR = +arg('refpr', 4), REFMS = +arg('refms', 4);
const RATE  = +arg('rate', 1);
const NOFREEZE = has('nofreeze');
const GRAIN = has('grain');
const OUT   = arg('out', 'shots/k30');
const MOTION = arg('motion', 'roofline');

const COMBOS = (arg('combos', '1.264x2,1x4,1.264x0,1.5x2') || '')
  .split(',').map(s => s.split('x').map(Number));

/* the five motions, copied from _k29-crawl.mjs unchanged */
const MOTIONS = {
  roofline: { name: 'roofline', place: 'cafe', kind: 'pan', yaw: -176.5, eyeH: 1.66, pitch: 10, deg: 12,
    clip: { x: 880, y: 360, w: 700, h: 440 } },
  fence: { name: 'fence', place: 'farmcoop', kind: 'strafe', yaw: -45, eyeH: 1.62, pitch: -4, mps: 1.4,
    clip: { x: 400, y: 160, w: 700, h: 500 } },
  grass: { name: 'grass', place: 'cafe', kind: 'forward', yaw: -176.5, eyeH: 1.05, pitch: -4, mps: 1.4,
    clip: { x: 350, y: 360, w: 700, h: 340 } },
  orbit: { name: 'orbit', place: 'bank', kind: 'orbit', yaw: 0, r: 26, eyeH: 9, pitch: 0, deg: 9, look: 11,
    clip: { x: 430, y: 330, w: 700, h: 440 } },
  drift: { name: 'drift', place: 'cafe', kind: 'forward', yaw: 25, eyeH: 125, pitch: -32, mps: 6,
    clip: { x: 450, y: 230, w: 700, h: 440 } },
};

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

const SETUP = (M) => {
  const p = window.WALLY.ctx.wally.position;
  const g = window.WALLY.debug.worldHeight(p.x, p.z).y;
  return { ex: p.x, ez: p.z, ey: g + M.eyeH, cx: p.x, cy: g, cz: p.z, ground: g };
};

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

const M = MOTIONS[MOTION];
if (!M) { console.error(`unknown motion '${MOTION}'`); process.exit(2); }

console.log('# _k30-judge — judge\'s re-run of the crawl instrument, frames kept.');
console.log('# rig: headless Chrome (channel chrome), WebGL2 ANGLE Metal, Apple M1 Max, macOS 14.4, playwright-core.');
console.log(`# ${W}x${H} CSS @ dsf ${DSF}, ?skipIntro&hour=${HOUR}, governor OFF, Wally hidden, ${N} steps, rate x${RATE}.`);
console.log(`# world ${NOFREEZE ? 'ALIVE (the confound, on purpose)' : 'FROZEN'}   grain ${GRAIN ? 'ON' : 'OFF'}   ref pr${REFPR}+ms${REFMS}`);

const l0 = await loadGate(MAXLOAD);
console.log(`# machine load (1-min) before: ${l0}`);

const logs = [];
const { page, close } = await boot({ w: W, h: H, phone: false, dpr: DSF, logs, qs: `?skipIntro&hour=${HOUR}` });
await sleep(5000);

let arrived;
try { arrived = await page.evaluate((p) => WALLY.debug.arrive(p, true), M.place); }
catch (e) { arrived = 'threw: ' + e.message; }
if (arrived !== true) {
  console.error(`FATAL: arrive('${M.place}') returned ${JSON.stringify(arrived)}. Refusing to measure the boot position.`);
  await close(); process.exit(3);
}
await sleep(7000);

await page.evaluate(() => {
  WALLY.debug.governor(false);
  WALLY.debug.camFree();
  WALLY.ctx.wally.root.visible = false;
  for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
});
if (!GRAIN) await page.evaluate(() => WALLY.ctx.render.setGrain(0));
const env = await page.evaluate(ENVSTATE);
await sleep(1500);
const frozen = NOFREEZE ? 0 : await page.evaluate(FREEZE);
await sleep(800);

const S = await page.evaluate(`(${SETUP})(${JSON.stringify(M)})`);
Object.assign(S, { N, kind: M.kind, yaw: M.yaw, pitch: M.pitch ?? 0, deg: M.deg ?? 0,
  mps: M.mps ?? 0, r: M.r ?? 0, eyeH: M.eyeH, look: M.look ?? 0 });
await page.evaluate(INSTALL, [POSE, S]);
await page.evaluate((r) => { window.__K29.rate = r; window.__K29.dirty = true; }, RATE);

const at = await page.evaluate(async (n) => {
  window.__K29.step = (n / 2) | 0; window.__K29.dirty = true;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = WALLY.ctx.camera, d = new WALLY.THREE.Vector3(); c.getWorldDirection(d);
  let ol = null; WALLY.ctx.scene.traverse(o => { if (ol == null && o.material?.uniforms?.uOutlineScale) ol = o.material.uniforms.uOutlineScale.value; });
  const g = WALLY.debug.worldHeight(c.position.x, c.position.z);
  return { eye: c.position.toArray().map(v => +v.toFixed(2)), dir: d.toArray().map(v => +v.toFixed(3)),
    ground: g.y, zone: g.zone, agl: +(c.position.y - g.y).toFixed(2), outline: ol };
}, N);

console.log(`=== motion '${M.name}' (${M.kind})  arrive('${M.place}') TRUE  tier '${env.tier}'  hooks nulled ${frozen}  gpu ${env.gpu}`);
console.log(`    eye mid-path ${JSON.stringify(at.eye)}  dir ${JSON.stringify(at.dir)}  ground ${at.ground} m  agl ${at.agl} m  zone '${at.zone}'  live uOutlineScale ${at.outline}`);

const clip = { x: M.clip.x, y: M.clip.y, width: M.clip.w, height: M.clip.h };
const root = join(OUT, `${M.name}${RATE === 1 ? '' : '-r' + RATE}${NOFREEZE ? '-alive' : ''}${GRAIN ? '-grain' : ''}`);

async function sequence(pr, ms, tag) {
  const set = await page.evaluate(([p, m]) => {
    WALLY.debug.pixelRatio(p);
    const got = WALLY.debug.msaa(m);
    return { got, vp: WALLY.debug.viewport() };
  }, [pr, ms]);
  await sleep(1500);
  const dir = join(root, tag);
  await mkdir(dir, { recursive: true });
  for (let k = 0; k < N; k++) {
    await page.evaluate(async (kk) => {
      window.__K29.step = kk; window.__K29.dirty = true;
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    }, k);
    await page.screenshot({ path: join(dir, `${String(k).padStart(3, '0')}.png`), clip });
  }
  /* THE LINE _k29 DOES NOT PRINT FOR ITS REFERENCE. */
  console.log(`    ${String(tag).padEnd(12)} asked pr ${String(pr).padEnd(6)} msaa ${String(ms).padEnd(2)}` +
    `  ->  pixelRatio ${set.vp.pixelRatio}  samples ${set.got.samples}/${set.got.maxSamples}` +
    `  buffer ${set.vp.buffer[0]}x${set.vp.buffer[1]} (${set.vp.mpx} Mpx)  sceneRT ${set.vp.sceneRT[0]}x${set.vp.sceneRT[1]}  inSync ${set.vp.inSync}`);
  return dir;
}

await sequence(REFPR, REFMS, 'ref');
for (const [pr, ms] of COMBOS) await sequence(pr, ms, `pr${String(pr).replace('.', '_')}ms${ms}`);
await sequence(COMBOS[0][0], COMBOS[0][1], 'null');

console.log(`    page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}   frames -> ${root}`);
console.log(`# machine load (1-min) after: ${load1()}`);
await close();
