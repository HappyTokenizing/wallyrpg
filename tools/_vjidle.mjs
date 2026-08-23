/* _vjidle.mjs — VERIFY JUDGE harness for Hide UI stage two (idle auto-hide).
   Independent of tools/touchtest.mjs: every claim is re-measured here from
   raw event records taken INSIDE the page, not inferred from end state. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return c; };

const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);

const cdp = await ctxM.newCDPSession(page);
const P = (x, y, id = 1) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: (type === 'touchEnd' || type === 'touchCancel') ? [] : pts,
});
const t1 = (type, x, y) => touch(type, [P(x, y)]);

/* ---------- MY OWN INSTRUMENTATION, installed at window capture (which
   runs before touch.js's document-capture listeners) plus a document
   BUBBLE listener, so every event is seen raw AND its survival through
   propagation is measured. ---------- */
await page.evaluate(() => {
  const desc = (t) => !t ? 'null' : (t === document ? 'document' : t.tagName ?
    (t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\s+/).join('.') : '')) : String(t));
  window.__J = { on: false, log: [], bub: [], interacts: 0, vy: 0, ymax: -1e9, dlgPages: [] };
  window.__desc = desc;
  const snap = () => { const i = WALLY.debug.idle(); return { hidden: i.hidden, wakes: i.wakes, live: i.live, cand: i.cand, pending: i.pending, why: i.why, t: i.t }; };
  window.__snap = snap;
  for (const ty of ['pointerdown', 'pointermove', 'pointerup', 'click', 'touchstart', 'touchend']) {
    addEventListener(ty, (e) => {
      if (!window.__J.on) return;
      if (ty === 'pointermove' && window.__J.log.length > 400) return;
      window.__J.log.push({ ty, x: Math.round(e.clientX || 0), y: Math.round(e.clientY || 0), tgt: desc(e.target), ts: Math.round(e.timeStamp), ...snap() });
    }, true);
    document.addEventListener(ty, (e) => {
      if (!window.__J.on) return;
      if (ty === 'pointermove') return;
      window.__J.bub.push({ ty, tgt: desc(e.target), dp: e.defaultPrevented, post: snap() });
    }, false);
  }
  /* interact counter — the pad's Enter and the keyboard both go through it */
  const ui = WALLY.ctx.ui; const raw = ui.interact.bind(ui);
  Object.defineProperty(ui, 'interact', { configurable: true, value: (...a) => { window.__J.interacts++; return raw(...a); } });
  /* jump/airborne sampler */
  const loop = () => {
    const c = WALLY.ctx.wally?.controller; const v = c && (c.velocity || c.vel);
    if (v) window.__J.vy = Math.max(window.__J.vy, v.y);
    const p = WALLY.ctx.wally?.position; if (p) window.__J.ymax = Math.max(window.__J.ymax, p.y);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

const arm = () => page.evaluate(() => { window.__J.on = true; window.__J.log = []; window.__J.bub = []; window.__J.interacts = 0; window.__J.vy = -9; window.__J.ymax = -1e9; });
const stop = () => page.evaluate(() => { window.__J.on = false; return { log: window.__J.log, bub: window.__J.bub, interacts: window.__J.interacts, vy: window.__J.vy, ymax: window.__J.ymax }; });
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const idleSet = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);

/* MY OWN pad read: computed style + a real hit test at each centre. */
const pad = () => page.evaluate(() => {
  const one = (sel) => {
    const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hitEl = document.elementFromPoint(cx, cy);
    return {
      op: +(+cs.opacity).toFixed(3), vis: cs.visibility, disp: cs.display,
      w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(cx), cy: Math.round(cy),
      under: window.__desc(hitEl), self: !!(hitEl && (hitEl === el || el.contains(hitEl))),
      visible: cs.visibility === 'visible' && cs.display !== 'none' && +cs.opacity > 0.02 && r.width > 0,
    };
  };
  return { stick: one('.w-stickzone'), acts: one('.w-acts'), act: one('.w-abtn.act'), jump: one('.w-abtn.jump'), seam: one('.w-idleseam'), idle: WALLY.debug.idle() };
});
const gone = (p) => !p.stick.visible && !p.acts.visible && !p.act.visible && !p.jump.visible;
const there = (p) => p.stick.visible && p.acts.visible && p.act.visible && p.jump.visible;
const wallyP = () => page.evaluate(() => { const p = WALLY.ctx.wally.position; return [p.x, p.y, p.z]; });
const yaw = () => page.evaluate(() => WALLY.ctx.cam.yaw);
const spin = (a, b) => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
const dist = (a, b) => Math.hypot(b[0] - a[0], b[2] - a[2]);

async function tapOnce(x, y, hold = 45) { await t1('touchStart', x, y); await page.waitForTimeout(hold); await t1('touchEnd', x, y); }
async function dbl(x, y, settle = 800) { await t1('touchStart', x, y); await t1('touchEnd', x, y); await t1('touchStart', x, y); await t1('touchEnd', x, y); await page.waitForTimeout(settle); }
async function drag(x, y, dx, dy, steps = 8, step = 30) {
  await t1('touchStart', x, y); await page.waitForTimeout(30);
  for (let i = 1; i <= steps; i++) { await t1('touchMove', x + dx * i / steps, y + dy * i / steps); await page.waitForTimeout(step); }
  await t1('touchEnd', x + dx, y + dy); await page.waitForTimeout(120);
}
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const open = () => page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);

await open();
await page.waitForTimeout(900);
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(600);

const D = 1.4;
const ship = await idleGet();
ok(ship.delay === 5 && ship.armed === true, 'VJ-0 [idleArmed]: shipping window is 5 s and arms with Hide UI on', JSON.stringify(ship));
await idleSet(D);
const goIdle = async (d = D) => { await page.waitForTimeout(d * 1000 + 900); return pad(); };

/* ============ 1. THE FEATURE DOES ITS JOB: it fades ============ */
let p = await goIdle();
ok(gone(p), 'VJ-1 [idleTick counting->setIdleHidden(true)]: the stick and the whole act cluster fade out on idle',
  `stick op ${p.stick.op}/${p.stick.vis}, acts op ${p.acts.op}, seam op ${p.seam.op}`);
ok(p.stick.w > 0 && p.acts.w > 0, 'VJ-2 [visibility not display]: the faded cluster keeps its box', `${p.stick.w}x${p.stick.h}`);

/* ============ 2. A CAMERA DRAG DOES NOT WAKE — SAMPLED AT EVERY EVENT ============ */
const y0 = await yaw(); const c0 = await wallyP();
await arm();
await drag(200, 420, 150, 0, 10, 26);
let r = await stop();
const y1 = await yaw(); const c1 = await wallyP();
p = await pad();
const dl = r.log.filter(e => e.ty === 'pointerdown' || e.ty === 'pointermove' || e.ty === 'pointerup');
const dlPost = r.bub.filter(e => e.ty === 'pointerdown' || e.ty === 'pointerup');
ok(dl.length >= 8 && dl.every(e => e.hidden === true) && dl.every(e => e.wakes === dl[0].wakes)
  && dlPost.length >= 2 && dlPost.every(e => e.post.hidden === true && e.post.wakes === dl[0].wakes),
  'VJ-3 [tapDown two=false -> tapUp !wasTap]: at the drag touchStart, at every move and at its release the controls were STILL hidden and the wake counter never moved',
  `${dl.length} events sampled, hidden ${[...new Set(dl.map(e => e.hidden))]}, wakes ${[...new Set(dl.map(e => e.wakes))]}`);
ok(gone(p) && spin(y0, y1) > 0.15 && dist(c0, c1) < 0.35,
  'VJ-4 [moving()=false on a camera drag]: the camera really turned, he did not move, the pad stayed gone',
  `yaw ${spin(y0, y1).toFixed(2)} rad, moved ${dist(c0, c1).toFixed(2)} m`);

/* --- the same, but the drag STARTS 60 ms after a real tap: the
       candidate path, released by travel (tapMove past TAP_SLOP) --- */
const w0 = (await idleGet()).wakes;
await tapOnce(200, 420, 45);
await page.waitForTimeout(60);
const pend = (await idleGet()).pending;
const yA = await yaw();
await arm();
await drag(200, 420, 150, 0, 10, 24);
r = await stop();
const yB = await yaw(); p = await pad();
const dl2 = r.log.filter(e => e.ty === 'pointerdown' || e.ty === 'pointermove' || e.ty === 'pointerup');
ok(pend === true, 'VJ-5a [tapUp: pending armed]: the tap before the drag really was recorded as tap one', `pending ${pend}`);
const dl2Post = r.bub.filter(e => e.ty === 'pointerdown' || e.ty === 'pointerup');
ok(dl2.length >= 8 && dl2.every(e => e.hidden === true) && p.idle.wakes === w0
  && dl2Post.every(e => e.post.hidden === true && e.post.wakes === w0),
  'VJ-5 [tapMove: candidate RELEASED by travel]: a 150 px drag starting 60 ms after a tap, from the same point, never woke at its touchStart or at any move',
  `${dl2.length} events, wakes ${w0} -> ${p.idle.wakes}`);
ok(spin(yA, yB) > 0.15 && gone(p), 'VJ-6 [...and the released candidate kept its drag]: the camera turned through it', `yaw ${spin(yA, yB).toFixed(2)} rad`);

/* ============ 3. A 1200 ms PRESS-AND-HOLD IS NOT TAP TWO ============ */
const w1 = (await idleGet()).wakes;
await tapOnce(240, 400, 45);
await page.waitForTimeout(60);
const pend2 = (await idleGet()).pending;
await arm();
await t1('touchStart', 240, 400);
await page.waitForTimeout(1200);
await t1('touchEnd', 240, 400);
await page.waitForTimeout(500);
r = await stop(); p = await pad();
const hd = r.log.find(e => e.ty === 'pointerdown'), hu = r.log.find(e => e.ty === 'pointerup');
const dur = hd && hu ? Math.round(hu.ts - hd.ts) : -1;
/* window-capture runs BEFORE touch.js's document-capture listener, so the
   candidate flag is read at document BUBBLE — after tapDown has judged it. */
const hdPost = r.bub.find(e => e.ty === 'pointerdown');
ok(pend2 === true && hdPost && hdPost.post.cand === true,
  'VJ-7a [tapDown: the hold WAS armed as a candidate]: the gate under test is really being entered, and its pointerdown was eaten',
  `pending ${pend2}, cand after tapDown ${hdPost && hdPost.post.cand}, defaultPrevented ${hdPost && hdPost.dp}`);
ok(dur > 400 && gone(p) && p.idle.wakes === w1,
  'VJ-7 [tapUp: c.cand && !wasTap(duration) -> RELEASED]: a 1200 ms stationary press 60 ms after a tap is not tap two and woke nothing',
  `contact ${dur} ms of TAP_MS 400, wakes ${w1} -> ${p.idle.wakes}`);

/* ============ 4. THE POSITIVE BRANCH, FROM EVERY REGION ============ */
const padBox = await page.evaluate(() => {
  const b = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; };
  return { act: b('.w-abtn.act'), jump: b('.w-abtn.jump'), stick: b('.w-stickzone'), gear: (() => { const e = [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')].pop().getBoundingClientRect(); return [Math.round(e.left + e.width / 2), Math.round(e.top + e.height / 2)]; })() };
});
const REGIONS = [
  ['centre of the world', [195, 420]], ['top-left', [40, 90]], ['top-right', [350, 90]],
  ['bottom-left dead corner', [24, 820]], ['over the hidden thumbstick', padBox.stick],
  ['over the hidden ENTER', padBox.act], ['over the hidden Jump', padBox.jump],
  ['over the hidden shortcut row', padBox.gear], ['dead centre bottom', [195, 780]],
];
let regionOk = true; const regionLog = [];
for (const [name, pt] of REGIONS) {
  p = await goIdle();
  if (!gone(p)) { regionOk = false; regionLog.push(name + ':NOT-FADED'); continue; }
  const before = p.idle.wakes;
  await dbl(pt[0], pt[1]);
  p = await pad();
  const won = there(p) && p.idle.wakes === before + 1;
  if (!won) { regionOk = false; regionLog.push(`${name}:${p.idle.wakes - before}/${there(p)}`); }
}
ok(regionOk, 'VJ-8 [tapDown gap+distance -> tapUp commit -> wake()]: a double tap wakes from all nine screen regions, including over each hidden control', regionLog.length ? regionLog.join(' ') : 'nine of nine');

/* ============ 5. THE WAKE TAP FIRES NOTHING ============ */
/* at a door, so ENTER is live the moment it is pressable */
const atDoor = await page.evaluate(() => {
  const l = WALLY.debug.game.data.locationById['broker'] || WALLY.debug.game.data.locations[1];
  WALLY.ctx.wally.warpTo(l.world.x, WALLY.ctx.wally.position.y, l.world.z + 2.2, {});
  return true;
});
await page.waitForTimeout(1400);
const near0 = await page.evaluate(() => !!WALLY.ctx.ui.near);
p = await goIdle();
ok(gone(p), 'VJ-9a [re-arm at a door]', `ui.near ${near0}`);
const wD = p.idle.wakes; const pd0 = await wallyP();
await arm();
await dbl(padBox.act[0], padBox.act[1]);
r = await stop(); p = await pad(); const pd1 = await wallyP();
const panels = await page.evaluate(() => WALLY.ctx.ui.panels);
ok(there(p) && p.idle.wakes === wD + 1 && r.interacts === 0 && panels.length === 0 && dist(pd0, pd1) < 0.3,
  'VJ-10 [eat() + click swallow]: a double tap on the hidden ENTER at a door wakes and fires NO interact — no panel, no door, no lurch',
  `interacts ${r.interacts}, panels ${JSON.stringify(panels)}, moved ${dist(pd0, pd1).toFixed(2)} m`);
p = await goIdle();
const wJ = p.idle.wakes; const jy0 = (await wallyP())[1];
await arm();
await dbl(padBox.jump[0], padBox.jump[1]);
r = await stop(); p = await pad();
ok(there(p) && p.idle.wakes === wJ + 1 && r.vy < 0.6 && (r.ymax - jy0) < 0.25,
  'VJ-11 [wake on the hidden Jump]: it wakes and no jump is launched — vertical speed never leaves the AIR_EPS band',
  `max vy ${r.vy.toFixed(2)} (AIR_EPS 0.6), rise ${(r.ymax - jy0).toFixed(2)} m`);

/* the wake tap reaches nothing at all: a LIVE non-canvas target injected
   over the faded controls, counted on the element itself */
p = await goIdle();
ok(gone(p), 'VJ-12a [re-arm for the swallow case]');
await page.evaluate(() => {
  const b = document.createElement('button');
  b.id = 'vjtgt'; b.textContent = 'X';
  Object.assign(b.style, { position: 'fixed', left: '120px', top: '380px', width: '150px', height: '110px', zIndex: '99999', pointerEvents: 'auto' });
  window.__tgt = { down: 0, up: 0, click: 0 };
  b.addEventListener('pointerdown', () => window.__tgt.down++);
  b.addEventListener('pointerup', () => window.__tgt.up++);
  b.addEventListener('click', () => window.__tgt.click++);
  document.body.append(b);
});
const tgtLive = await page.evaluate(() => { const e = document.elementFromPoint(195, 435); return !!e && e.id === 'vjtgt'; });
ok(tgtLive, 'VJ-12b [the injected target really wins the hit test]');
await dbl(195, 435);
const tgt = await page.evaluate(() => window.__tgt);
p = await pad();
await page.evaluate(() => document.getElementById('vjtgt')?.remove());
ok(there(p) && tgt.down === 1 && tgt.click === 1,
  'VJ-12 [eat() at pointerdown + the click swallow]: of the two taps that woke the controls the SECOND delivered neither pointerdown nor click to the live element under it',
  `${JSON.stringify(tgt)}, wakes -> ${p.idle.wakes}`);

/* ============ 6. THE FADE-IN IS INERT ============ */
await open(); await page.waitForTimeout(1000);
await page.evaluate(() => WALLY.debug.hideUI(true));
p = await goIdle();
ok(gone(p), 'VJ-13a [re-arm for the fade-in gate]');
await arm();
await dbl(padBox.jump[0], padBox.jump[1], 0);      // wake, and measure at once
const mid = await page.evaluate(([x, y]) => ({ i: WALLY.debug.idle(), under: window.__desc(document.elementFromPoint(x, y)), op: +(+getComputedStyle(document.querySelector('.w-abtn.jump')).opacity).toFixed(2) }), padBox.jump);
await t1('touchStart', padBox.jump[0], padBox.jump[1]);
await page.waitForTimeout(40);
await t1('touchEnd', padBox.jump[0], padBox.jump[1]);
const mid2 = await page.evaluate(([x, y]) => ({ i: WALLY.debug.idle(), under: window.__desc(document.elementFromPoint(x, y)) }), padBox.jump);
await page.waitForTimeout(900);
r = await stop();
const late = await page.evaluate(([x, y]) => ({ i: WALLY.debug.idle(), under: window.__desc(document.elementFromPoint(x, y)) }), padBox.jump);
ok(mid.i.hidden === false && mid.i.live === false && mid.under.includes('canvas') && mid.op < 0.95,
  'VJ-13 [.w-idlewake]: mid fade-in the Jump button is drawn but NOT hit-testable — a finger there reaches the canvas',
  `live ${mid.i.live}, opacity ${mid.op}, under ${mid.under}`);
ok(mid2.under.includes('canvas') && r.vy < 0.6,
  'VJ-14 [the third tap of a triple tap]: a tap landing inside the 0.42 s fade-in pressed nothing — no jump',
  `under ${mid2.under}, max vy ${r.vy.toFixed(2)}`);
ok(late.i.live === true && late.under.includes('jump'),
  'VJ-15 [goLive]: once the fade completes the same point reaches the Jump button again', `under ${late.under}`);

/* ============ 7. A DIALOGUE OVER FADED CONTROLS ============ */
p = await goIdle();
ok(gone(p), 'VJ-16a [faded, before the dialogue opens]');
/* NOT returned: ui.dialogue() resolves only when the card closes, and
   page.evaluate awaits whatever it is handed. */
await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Judge', role: 'probe', text: ['PAGE ONE of the probe.', 'PAGE TWO of the probe.', 'PAGE THREE of the probe.'] }); });
await page.waitForTimeout(1100);
const sus = await idleGet();
p = await pad();
ok(sus.hidden === false && sus.why === 'dialogue' && there(p),
  'VJ-16 [idleSuspended() reached FROM hidden -> setIdleHidden(false)]: a dialogue opening over faded controls RESTORES the pad',
  `why ${sus.why}, act op ${p.act.op}`);
ok(sus.live === true && p.act.self === true && p.jump.self === true,
  'VJ-17 [...and it is hit-testable, not just drawn]: the Enter and Jump buttons win their own hit tests',
  `live ${sus.live}, under act ${p.act.under}`);
/* and drive it: the pad's Enter must actually advance the conversation */
const pg0 = await page.evaluate(() => document.querySelector('.w-dlg-tx .gh')?.textContent || '');
await arm();
await tapOnce(padBox.act[0], padBox.act[1], 45);
await page.waitForTimeout(700);
r = await stop();
const pg1 = await page.evaluate(() => document.querySelector('.w-dlg-tx .gh')?.textContent || '');
ok(r.interacts >= 1 && pg1 !== pg0,
  'VJ-18 [the restored pad really works]: one tap on the restored Enter advances the conversation',
  `interacts ${r.interacts}, "${pg0.slice(0, 14)}" -> "${pg1.slice(0, 14)}"`);
/* two taps on the CARD under a dialogue: neither may be eaten */
await page.evaluate(() => {
  const c = document.querySelector('.w-dlg');
  window.__card = { down: 0, click: 0 };
  c.addEventListener('pointerdown', () => window.__card.down++, true);
  c.addEventListener('click', () => window.__card.click++, true);
});
const cardPt = await page.evaluate(() => { const r = document.querySelector('.w-dlg').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + 26)]; });
await dbl(cardPt[0], cardPt[1], 600);
const card = await page.evaluate(() => window.__card);
const susWhy = (await idleGet()).why;
ok(card.down === 2 && card.click === 2 && susWhy === 'dialogue',
  'VJ-19 [tapDown early-return on idleSuspended()]: with a conversation open no tap is eaten — the card takes two pointerdowns and two clicks',
  `${JSON.stringify(card)}, why ${susWhy}`);
await page.evaluate(() => WALLY.ctx.ui.hide('dialogue'));
await page.waitForTimeout(600);

/* ============ 8. A SHEET OVER FADED CONTROLS ============ */
for (const [name, opener] of [['the phone', 'phone'], ['the pause sheet', 'pause']]) {
  await open(); await page.waitForTimeout(700);
  p = await goIdle();
  if (!ok(gone(p), `VJ-20a [faded, before ${name} opens]`)) continue;
  await page.evaluate((k) => { if (k === 'phone') WALLY.ctx.ui.openPhone(); else WALLY.ctx.ui.show('pause'); return null; }, opener);
  await page.waitForTimeout(900);
  const st = await idleGet();
  /* a real button of the sheet, plus a counted one injected INTO it */
  const btn = await page.evaluate(() => {
    const panels = document.querySelector('.w-panels');
    const top = panels.lastElementChild;
    const b = document.createElement('button');
    b.id = 'vjsheet'; b.textContent = 'sheet button';
    Object.assign(b.style, { position: 'fixed', left: '95px', top: '360px', width: '200px', height: '110px', zIndex: '9999' });
    window.__sh = { down: 0, click: 0 };
    b.addEventListener('pointerdown', () => window.__sh.down++);
    b.addEventListener('click', () => window.__sh.click++);
    top.append(b);
    const win = document.elementFromPoint(195, 415);
    return { top: top.className, wins: !!win && win.id === 'vjsheet' };
  });
  await dbl(195, 415, 600);
  const sh = await page.evaluate(() => window.__sh);
  await page.evaluate(() => document.getElementById('vjsheet')?.remove());
  ok(btn.wins && st.why === 'modal' && st.hidden === false && sh.down === 2 && sh.click === 2,
    `VJ-20 [tapDown early-return on idleSuspended('modal')]: with ${name} open over faded controls BOTH taps reach the button underneath`,
    `why ${st.why}, ${JSON.stringify(sh)}`);
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.waitForTimeout(700);
}

/* ============ 9. THE DOUBLE TAP THAT STRADDLES THE FADE ============ */
await open(); await page.waitForTimeout(800);
await idleSet(4);
await page.waitForTimeout(300);
p = await pad();
ok(there(p), 'VJ-21a [visible, for the straddle case]', `t ${p.idle.t}`);
await page.evaluate(() => {
  window.__str = { saw: [], gap: -1, down1: 0, up1: 0, dur1: -1, pend1: null };
  const rec = (e) => {
    const s = window.__str; s.saw.push(WALLY.debug.idle().hidden);
    if (s.up1) s.gap = Math.round(e.timeStamp - s.up1); else s.down1 = e.timeStamp;
    if (s.saw.length >= 2) document.removeEventListener('pointerdown', rec, true);
  };
  document.addEventListener('pointerdown', rec, true);
  const fade = (e) => {
    document.removeEventListener('pointerup', fade, true);
    const s = window.__str; s.up1 = e.timeStamp; s.dur1 = Math.round(e.timeStamp - s.down1);
    s.pend1 = WALLY.debug.idle().pending;
    WALLY.debug.idle(0);
    const back = () => { if (WALLY.debug.idle().hidden) { WALLY.debug.idle(4); return; } requestAnimationFrame(back); };
    requestAnimationFrame(back);
  };
  document.addEventListener('pointerup', fade, true);
});
const wS = (await idleGet()).wakes;
await t1('touchStart', 195, 300); await t1('touchEnd', 195, 300);
await page.waitForTimeout(80);
await t1('touchStart', 195, 300); await t1('touchEnd', 195, 300);
await page.waitForTimeout(700);
p = await pad();
const str = await page.evaluate(() => window.__str);
ok(str.saw.length === 2 && str.saw[0] === false && str.saw[1] === true,
  'VJ-21 [the fade really landed BETWEEN the two taps]', JSON.stringify(str.saw));
ok(str.pend1 === true && str.gap >= 0 && str.gap <= 300 && there(p) && p.idle.wakes === wS + 1,
  'VJ-22 [the detector runs while the controls are still up]: tap one before the fade and tap two after it is one gesture and it wakes',
  `gap ${str.gap} ms, tap one lasted ${str.dur1} ms, pending ${str.pend1}, wakes ${wS} -> ${p.idle.wakes}`);
await idleSet(D);

/* ============ 10. BACKGROUND TIME IS NOT IDLE TIME ============ */
await dbl(195, 300);
await idleSet(D);
const pre = await page.evaluate(() => {
  const b = WALLY.debug.idle();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__bg === true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__bg ? 'hidden' : 'visible') });
  window.__bg = true; document.dispatchEvent(new Event('visibilitychange'));
  return b;
});
const reallyHidden = await page.evaluate(() => document.hidden);
await page.waitForTimeout(D * 1000 * 3);
const away = await idleGet();
const padAway = await pad();
await page.evaluate(() => { window.__bg = false; document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(200);
const home = await idleGet();
/* THE STRONGER CLAIM: the window is handed back WHOLE. Wait 70 % of it
   and the controls must still be up; the remaining 30 % + slack fades. */
await page.waitForTimeout(D * 700);
const partway = await pad();
await page.waitForTimeout(D * 700 + 700);
const after = await pad();
await page.evaluate(() => { delete document.hidden; delete document.visibilityState; });
ok(reallyHidden === true && pre.hidden === false, 'VJ-23a [the page really reports itself hidden]');
ok(away.why === 'background' && away.hidden === false && padAway.stick.visible,
  'VJ-23 [idleTick: document.hidden]: three whole windows in another app with the loop running and nothing faded',
  `why ${away.why}, t ${away.t} (was ${pre.t})`);
ok(home.t < 0.5 && there(partway) && gone(after),
  'VJ-24 [resumeSkip]: the first frame home banks no catch-up and the FULL window is handed back — still up at 70 % of it, faded after it',
  `t on return ${home.t}, at 70 % ${partway.idle.t} visible ${there(partway)}, after ${after.idle.t}`);

/* ============ 11. PROBE: the click-swallow window outliving its click ============ */
/* After a commit whose click never arrives, swallowUntil stays armed for
   the rest of SWALLOW_MS and would eat the next unrelated click. */
await idleSet(D);
p = await goIdle();
const swWakes = p.idle.wakes;
await page.evaluate(() => {
  const b = document.createElement('button');
  b.id = 'vjsw'; Object.assign(b.style, { position: 'fixed', left: '20px', top: '150px', width: '160px', height: '90px', zIndex: '99999' });
  window.__sw = { click: 0 };
  b.addEventListener('click', () => window.__sw.click++);
  document.body.append(b);
});
await dbl(300, 640, 0);                              // wake over the canvas
await page.waitForTimeout(455);                      // inside SWALLOW_MS, past the fade
await tapOnce(100, 195, 40);
await page.waitForTimeout(500);
const sw = await page.evaluate(() => { const v = window.__sw; document.getElementById('vjsw')?.remove(); return v; });
p = await pad();
ok(p.idle.wakes === swWakes + 1 && sw.click === 1,
  'VJ-25 [tapClick swallow window]: a genuine tap on a live control 455 ms after the wake commit is NOT eaten by the leftover swallow window',
  `clicks ${sw.click}, wakes ${swWakes} -> ${p.idle.wakes}`);

await idleSet(null);
console.log(fails ? `\nFAIL — ${fails} assertion(s) red.` : '\nPASS — every assertion green.');
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
