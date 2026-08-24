/* _fl2.mjs — a REAL first visit.
   Fresh browser profile (no MEI, no cache, no localStorage), cold HTTP
   with artificial per-file latency, one real gesture, and the intro
   driven the way a player drives it — including WATCHED TO THE END,
   which no suite in tools/ has ever done.

   node tools/_fl2.mjs --mode watch     watch the whole opener, then move
   node tools/_fl2.mjs --mode skipearly tap immediately (the old rig)
   node tools/_fl2.mjs --mode skiplate  tap at ~20 s, mid-ride
   node tools/_fl2.mjs --mode mash      hold W from the gate onward
   flags: --latency 120  --profile <dir>  --reload  --mobile
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const MODE = arg('mode', 'watch');
const LAT = +arg('latency', 0);
const MOBILE = has('mobile');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
let reqs = 0;
const server = createServer(async (rq, rs) => {
  reqs++;
  const c = decodeURIComponent(rq.url.split('?')[0]);
  if (LAT) await new Promise((r) => setTimeout(r, LAT));
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, {
      'content-type': MIME[extname(c)] || 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
    });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = arg('profile', await mkdtemp(join(tmpdir(), 'wally-fresh-')));
console.log(`mode=${MODE} latency=${LAT}ms mobile=${MOBILE} profile=${profile}`);

const ctxOpts = {
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--autoplay-policy=user-gesture-required'],
  channel: 'chrome',
  viewport: MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 720 },
  hasTouch: MOBILE, isMobile: MOBILE,
  deviceScaleFactor: MOBILE ? 3 : 1,
  userAgent: MOBILE
    ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
    : undefined,
};
if (has('headed')) ctxOpts.headless = false;
const context = await chromium.launchPersistentContext(profile, ctxOpts);
const page = context.pages()[0] || await context.newPage();

/* ---------------------------------------------------------------
   THE REAL AUTOPLAY GATE.
   Measured: headless Chrome hands out an AudioContext already in
   state 'running', with or without --autoplay-policy, so
   openTheDoor() has ALWAYS taken its `allowed` branch and ask() —
   the PRESS ANY KEY start beat — has never once executed in this
   repo's tooling.  This reinstates the documented desktop/mobile
   behaviour: a context constructed with no user activation is
   suspended, and resume() outside a gesture never settles.
   --------------------------------------------------------------- */
if (has('realgate')) {
  await page.addInitScript(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let gesture = false;
    const mark = () => { gesture = true; };
    addEventListener('pointerdown', mark, { capture: true });
    addEventListener('keydown', mark, { capture: true });
    addEventListener('touchstart', mark, { capture: true, passive: true });
    window.__GATE__ = () => gesture;
    class Gated extends AC {
      get state() { return gesture ? super.state : 'suspended'; }
      resume() { return gesture ? super.resume() : new Promise(() => {}); }
    }
    window.AudioContext = Gated;
    window.webkitAudioContext = Gated;
  });
}
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

/* ---- the one probe. Everything "frozen" could mean, in one read. ---- */
const PROBE = () => {
  const g = (f, d = null) => { try { const v = f(); return v === undefined ? d : v; } catch { return d; } };
  const c = window.WALLY?.ctx;
  const w = c?.wally; const ct = w?.controller;
  const r = w?.root?.position;
  const act = g(() => w.animator?.action);
  return {
    t: +(performance.now() / 1000).toFixed(2),
    ready: window.__WALLY_READY__ === true,
    frame: c?.frame ?? null,                                   // is the FRAME LOOP alive?
    fps: g(() => window.__WALLY_PERF__?.fps),
    boot: g(() => document.getElementById('boot')?.className, ''),
    active: g(() => document.activeElement?.id || document.activeElement?.tagName, ''),
    started: g(() => window.WALLY.debug.started()),
    introRun: g(() => c.intro.running, null),
    introT: g(() => +c.intro.time.toFixed(2)),
    introState: g(() => window.WALLY.debug.introState()),
    camMode: g(() => c.cam.mode),
    camPos: g(() => { const p = c.camera.position; return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]; }),
    pos: r ? [+r.x.toFixed(3), +r.y.toFixed(3), +r.z.toFixed(3)] : null,   // is he MOVING?
    ctrlEnabled: ct ? ct.enabled : null,                        // is INPUT reaching him?
    ctrlIn: ct ? { x: +ct.input.x.toFixed(2), z: +ct.input.z.toFixed(2), run: ct.input.run } : null,
    speed: ct ? +ct.planarSpeed.toFixed(3) : null,
    clip: g(() => act?.name ?? act?.clip?.name ?? null),        // is he ANIMATING?
    clipT: g(() => act ? +(+act.time).toFixed(2) : null),
    panels: g(() => (c.ui.modal ? c.ui.panels : (c.ui.panels.length ? c.ui.panels : 0))),
    dlgOpen: g(() => c.ui.dialogue && null),
    inputFn: g(() => (w && w.setInput ? null : null)),
    orient: g(() => !!document.querySelector('.w-orient,.w-rotate')),
    touchOn: g(() => c.ui.touch?.enabled ?? null),
    mq: g(() => [
      'pointer: coarse', 'any-pointer: fine', 'pointer: fine', 'hover: none',
      'any-hover: hover', 'prefers-reduced-motion: reduce',
    ].filter((q) => matchMedia('(' + q + ')').matches).join(' | ')),
    audio: g(() => ({ run: window.WALLY.ctx.audio.running, un: window.WALLY.ctx.audio.unavailable })),
    health: g(() => window.__WALLY_HEALTH__ && {
      e: window.__WALLY_HEALTH__.errors, d: window.__WALLY_HEALTH__.disabled.length,
    }),
  };
};

const probe = () => page.evaluate(PROBE);
const wait = (ms) => page.waitForTimeout(ms);
const line = (tag, p) => console.log(
  `  ${String(tag).padEnd(11)} f=${String(p.frame).padStart(5)} intro=${p.introRun}@${p.introT}`
  + ` cam=${p.camMode} ctrl=${p.ctrlEnabled} in=${p.ctrlIn ? p.ctrlIn.x + ',' + p.ctrlIn.z : '-'}`
  + ` spd=${p.speed} pos=${p.pos ? p.pos[0] + ',' + p.pos[2] : '-'} clip=${p.clip}`
  + ` boot="${p.boot}" active=${p.active} panels=${JSON.stringify(p.panels)}`);

async function run(label) {
  console.log(`\n======== ${label} ========`);
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 })
    .catch(() => console.log('  !! READY never set'));
  await wait(1400);              // openTheDoor races resume() for 400 ms before ask()
  let p = await probe();
  line('READY', p);
  const askedForGesture = /\bask\b/.test(p.boot || '');
  console.log(`  gate: boot="${p.boot}"  askedForGesture=${askedForGesture}  started=${p.started}`
    + `  audio=${JSON.stringify(p.audio)}`);
  console.log(`  media: ${p.mq}   touchOn=${p.touchOn}`);

  // ---- ONE real gesture, the way a player gives it ----
  if (MOBILE) await page.touchscreen.tap(195, 500);
  else await page.keyboard.press('Space');
  console.log('  gesture sent');

  // ---- the timeline, sampled while the opener runs ----
  const t0 = Date.now();
  let mashing = false;
  if (MODE === 'mash') { await page.keyboard.down('KeyW'); mashing = true; }
  let skipped = false;
  const timeline = [];
  for (let i = 0; i < 150; i++) {
    await wait(700);
    p = await probe();
    timeline.push(p);
    const el = (Date.now() - t0) / 1000;
    if (i % 3 === 0 || p.introRun === false) line(`t+${el.toFixed(1)}s`, p);
    if (MODE === 'skipearly' && !skipped && el > 1.5) { await page.keyboard.press('KeyJ'); skipped = true; console.log('  -> skip key sent (early)'); }
    if (MODE === 'skiplate' && !skipped && el > 20) { await page.keyboard.press('KeyJ'); skipped = true; console.log('  -> skip key sent (late)'); }
    if (p.introRun === false && p.started && el > 3) break;
    if (el > 95) { console.log('  !! opener never ended in 95 s'); break; }
  }
  if (mashing) { await page.keyboard.up('KeyW'); }
  await wait(1200);

  // ---- now: does he move? sampled, not just before/after ----
  const before = await probe();
  line('BEFORE', before);
  await page.keyboard.down('KeyW');
  const samples = [];
  for (let i = 0; i < 8; i++) { await wait(250); samples.push(await probe()); }
  await page.keyboard.up('KeyW');
  await wait(400);
  const after = await probe();
  line('AFTER', after);
  for (const s of samples) line('  hold', s);

  const moved = (before.pos && after.pos)
    ? Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]) : -1;
  const frames = (after.frame ?? 0) - (before.frame ?? 0);
  console.log(`\n  DISPLACEMENT ${moved.toFixed(3)} m over ${frames} frames`
    + `  -> ${moved > 0.5 ? 'MOVES' : '*** FROZEN ***'}`);
  console.log(`  input reached controller: ${JSON.stringify(after.ctrlIn)}   enabled=${after.ctrlEnabled}`);
  console.log(`  clip=${after.clip} clipT=${after.clipT}  camMode=${after.camMode} camPos=${after.camPos}`);
  return { moved, frames, before, after };
}

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 180000 });
const first = await run(`FIRST VISIT (fresh profile, cold, ${MODE})`);

let second = null;
if (has('reload')) {
  await page.reload({ waitUntil: 'load', timeout: 180000 });
  second = await run(`AFTER RELOAD (same profile, ${MODE})`);
}

console.log('\n=== ERRORS ===');
for (const e of [...new Set(errs)].slice(0, 12)) console.log('  -', e);
console.log(`\nrequests served: ${reqs}`);
console.log(`RESULT first=${first.moved.toFixed(3)}m` + (second ? ` reload=${second.moved.toFixed(3)}m` : ''));

await context.close();
server.close();
