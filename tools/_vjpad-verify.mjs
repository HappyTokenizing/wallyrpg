/* _vjpad-verify.mjs — independent verification of the pad input change.
   Real Input.dispatchTouchEvent at 390x844, hasTouch + isMobile.
   Nothing here calls element.click() except the one deliberate
   keyboard-shaped detail-0 test. */
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
const note = (m) => console.log(`      · ${m}`);

const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);

const cdp = await ctxM.newCDPSession(page);
const pt = (id, x, y) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
const multi = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
const touch = (type, x, y) => multi(type, type === 'touchEnd' || type === 'touchCancel' ? [] : [pt(1, x, y)]);
const wait = (ms) => page.waitForTimeout(ms);
const press = async (x, y, hold = 60) => { await touch('touchStart', x, y); await wait(hold); await touch('touchEnd', x, y); };
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const nearId = () => page.evaluate(() => WALLY.ctx.ui.near ?? null);
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const idleSet = (s) => page.evaluate(v => WALLY.debug.idle(v), s);
const closeAll = () => page.evaluate(() => WALLY.ctx.ui.closeAll());
const camYaw = () => page.evaluate(() => { const f = new WALLY.THREE.Vector3(); WALLY.ctx.camera.getWorldDirection(f); return Math.atan2(f.x, f.z); });
const wallyXZ = () => page.evaluate(() => { const p = WALLY.ctx.wally.position; return [p.x, p.z]; });
const dlgText = () => page.evaluate(() => { const e = document.querySelector('.w-dlg'); return e ? e.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null; });
const speed = () => page.evaluate(() => { const v = WALLY.ctx.wally.controller.velocity; return +Math.hypot(v.x, v.z).toFixed(2); });

/* box helpers */
const box = (sel, i = 0) => page.evaluate(([s, k]) => {
  const b = document.querySelectorAll(s)[k]; if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, label: b.getAttribute('aria-label') };
}, [sel, i]);

const actP = await box('.w-abtn.act');
const jumpP = await box('.w-abtn.jump');
const stickP = await box('.w-stick');
const phoneB = await box('.w-acts .shortcuts .w-abtn', 0);
const deskB = await box('.w-acts .shortcuts .w-abtn', 2);
const gearB = await box('.w-acts .shortcuts .w-abtn', 3);
console.log('geometry', JSON.stringify({ actP, jumpP, stickP, phoneB, deskB, gearB }));

/* ---- the ledger. Handler-entry counters bound to the real elements'
   verbs, plus every pointer/click event with target, detail and the
   LIVE FLAG stamped in the page. `stub` counts without calling
   through, so a shortcut can be measured without a sheet landing on
   top of the button still under the other thumb. ---- */
const probe = (stub = false) => page.evaluate((st) => {
  window.__L = { ev: [], act: 0, sc: 0, scNames: [], toasts: [] };
  const u = WALLY.ctx.ui;
  if (!window.__orig) {
    window.__orig = { interact: u.interact.bind(u), openPhone: u.openPhone.bind(u), openDesk: u.openDesk.bind(u), show: u.show.bind(u), toast: u.toast.bind(u) };
    const desc = (t) => !t ? null : (t.id || (t.tagName.toLowerCase() + '.' + String(t.className?.baseVal ?? t.className ?? '').trim().split(/\s+/).join('.')));
    for (const t of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(t, (e) => {
        window.__L.ev.push({ type: e.type, target: desc(e.target), detail: e.detail, id: e.pointerId,
          inPad: !!e.target.closest?.('.w-touch'), live: WALLY.debug.idle().live });
      }, true);
    }
  }
  const o = window.__orig;
  u.interact = (...a) => { window.__L.act++; return st ? undefined : o.interact(...a); };
  u.openPhone = (...a) => { window.__L.sc++; window.__L.scNames.push('phone'); return st ? undefined : o.openPhone(...a); };
  u.openDesk = (...a) => { window.__L.sc++; window.__L.scNames.push('desk'); return st ? undefined : o.openDesk(...a); };
  u.show = (...a) => { window.__L.sc++; window.__L.scNames.push('show:' + a[0]); return st ? undefined : o.show(...a); };
  u.toast = (...a) => { window.__L.toasts.push(String(a[0])); return o.toast(...a); };
  return true;
}, stub);
const read = () => page.evaluate(() => {
  const L = window.__L;
  const clicks = L.ev.filter(e => e.type === 'click');
  return { act: L.act, sc: L.sc, scNames: L.scNames, toasts: L.toasts,
    down: L.ev.find(e => e.type === 'pointerdown'),
    clicks: clicks.map(e => ({ target: e.target, detail: e.detail, inPad: e.inPad })),
    seq: L.ev.map(e => `${e.type}${e.detail ? '(d' + e.detail + ')' : ''}->${e.target}`) };
});

const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  await wait(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await wait(300);
  return nearId();
};

await page.evaluate(() => WALLY.debug.hideUI(false));
await wait(500);

console.log('\n== M1: one finger, the control that must not regress ==');
let door = await toDoor();
await probe();
await press(actP.x, actP.y, 60);
await wait(900);
let r = await read(); let pn = await panels();
ok(door !== null && r.act === 1 && pn.includes('place'), 'M1 one-finger Enter opens the door, handler entered EXACTLY once (no double fire)',
  `near ${door}, act ${r.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(r.clicks)}`);
await closeAll(); await wait(600);

console.log('\n== M2: stick held stationary, Enter under the other thumb ==');
door = await toDoor();
await probe();
await multi('touchStart', [pt(1, stickP.x, stickP.y)]);
await wait(120);
await multi('touchStart', [pt(1, stickP.x, stickP.y), pt(2, actP.x, actP.y)]);
await wait(70);
await multi('touchEnd', [pt(2, actP.x, actP.y)]);
await wait(500);
r = await read(); pn = await panels();
await multi('touchEnd', [pt(1, stickP.x, stickP.y)]);
await wait(700);
ok(door !== null && r.act === 1 && pn.includes('place'), 'M2 stick held + Enter tapped: handler runs once AND the door opens',
  `near ${door}, act ${r.act}, panels ${JSON.stringify(pn)}`);
ok(!r.clicks.some(c => c.inPad), 'M2b no compatibility click ever reached the pad (so click could not have delivered it)', JSON.stringify(r.clicks));
await closeAll(); await wait(600);

console.log('\n== M3: WALKING on the stick, then Enter — the headline case ==');
door = await toDoor();
await probe();
const [x0, z0] = await wallyXZ();
await multi('touchStart', [pt(1, stickP.x, stickP.y)]);
await wait(60);
await multi('touchMove', [pt(1, stickP.x, stickP.y - 60)]);
await wait(180);
const spWalk = await speed();
await multi('touchMove', [pt(1, stickP.x, stickP.y + 60)]);   // walk back toward the door
await wait(200);
const spNow = await speed();
const nearAtTap = await nearId();
await multi('touchStart', [pt(1, stickP.x, stickP.y + 60), pt(2, actP.x, actP.y)]);
await wait(70);
await multi('touchEnd', [pt(2, actP.x, actP.y)]);
await wait(500);
r = await read(); pn = await panels();
await multi('touchEnd', [pt(1, stickP.x, stickP.y + 60)]);
await wait(700);
const [x1, z1] = await wallyXZ();
ok(spWalk > 0.4 && spNow > 0.4 && Math.hypot(x1 - x0, z1 - z0) > 0.3, 'M3a the case is really set up: he is genuinely walking on the stick and has moved',
  `speed ${spWalk} then ${spNow} m/s, moved ${Math.hypot(x1 - x0, z1 - z0).toFixed(2)} m, near ${nearAtTap}`);
ok(r.act === 1 && pn.includes('place'), 'M3 walking on the stick and pressing Enter OPENS THE DOOR',
  `act ${r.act}, panels ${JSON.stringify(pn)}, toasts ${JSON.stringify(r.toasts)}`);
await closeAll(); await wait(600);

console.log('\n== M4: two shortcut buttons pressed together (NOT covered by the suite) ==');
/* stubbed verbs: measures handler entry only, so no sheet lands on top
   of the button still under the other thumb */
await probe(true);
await multi('touchStart', [pt(1, phoneB.x, phoneB.y)]);
await wait(60);
await multi('touchStart', [pt(1, phoneB.x, phoneB.y), pt(2, gearB.x, gearB.y)]);
await wait(90);
await multi('touchEnd', [pt(2, gearB.x, gearB.y)]);
await wait(60);
await multi('touchEnd', [pt(1, phoneB.x, phoneB.y)]);
await wait(600);
r = await read();
ok(r.sc === 2 && r.scNames.includes('phone') && r.scNames.includes('show:pause'),
  'M4 Phone and Menu pressed together: BOTH handlers run (the exact gesture that fired neither before)',
  `entries ${r.sc} ${JSON.stringify(r.scNames)}`);
ok(!r.clicks.some(c => c.inPad), 'M4b and neither one got a compatibility click', JSON.stringify(r.clicks));

console.log('\n== M4c: same gesture, real verbs, released in the same dispatch ==');
await probe(false);
await multi('touchStart', [pt(1, phoneB.x, phoneB.y)]);
await wait(60);
await multi('touchStart', [pt(1, phoneB.x, phoneB.y), pt(2, deskB.x, deskB.y)]);
await wait(90);
await multi('touchEnd', [pt(1, phoneB.x, phoneB.y), pt(2, deskB.x, deskB.y)]);
await wait(800);
r = await read(); pn = await panels();
ok(r.sc === 2, 'M4c both shortcut verbs really ran with live panels in play',
  `entries ${r.sc} ${JSON.stringify(r.scNames)}, panels ${JSON.stringify(pn)}`);
await closeAll(); await wait(700);

console.log('\n== M5: keyboard / AT detail-0 activation, including after a stray contact ==');
door = await toDoor();
await probe();
const focusAct = () => page.evaluate(() => { const b = document.querySelector('.w-abtn.act'); b.focus(); return document.activeElement === b; });
let f = await focusAct();
await page.keyboard.press('Enter');
await wait(900);
r = await read(); pn = await panels();
/* THE HANDLER ENTRY IS THE MEASUREMENT, not the panel: ui.interact()
   at a door goes through game.enter(), which may legitimately refuse
   and toast instead (see PAD-7's note in touchtest.mjs). Observed once
   as act 1 / panels [] and not reproduced in three dedicated repeats. */
ok(f && r.act === 1, 'M5 a clean detail-0 activation still presses Enter',
  `act ${r.act}, panels ${JSON.stringify(pn)}, toasts ${JSON.stringify(r.toasts)}, clicks ${JSON.stringify(r.clicks)}`);
await closeAll(); await wait(600);

/* the shape the previous round's window ate: a stray contact first */
door = await toDoor();
await probe();
await press(230, 230, 60);              // stray contact on the canvas
await wait(80);
f = await focusAct();
await page.keyboard.press('Enter');
await wait(900);
r = await read(); pn = await panels();
ok(f && r.act === 1 && pn.includes('place'), 'M5b detail-0 activation 80 ms after a stray canvas contact still fires',
  `act ${r.act}, panels ${JSON.stringify(pn)}`);
await closeAll(); await wait(600);

/* the harder one: the stray contact is a REAL PAD PRESS, which arms the
   swallow itself, and the keypress lands before any other pointerdown
   can clear it */
door = await toDoor();
await probe();
await press(jumpP.x, jumpP.y, 60);      // a pad press: arms swallowClick
await wait(60);
f = await focusAct();
await page.keyboard.press('Enter');
await wait(900);
r = await read(); pn = await panels();
ok(f && r.act === 1 && pn.includes('place'), 'M5c detail-0 activation immediately after a pad press that armed the swallow still fires',
  `act ${r.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(r.clicks)}`);
await closeAll(); await wait(600);

/* and a two-finger stray, which produces NO compat click at all, so the
   swallow it armed has nothing of its own to close it */
door = await toDoor();
await probe();
await multi('touchStart', [pt(1, 230, 230)]);
await wait(50);
await multi('touchStart', [pt(1, 230, 230), pt(2, jumpP.x, jumpP.y)]);
await wait(70);
await multi('touchEnd', [pt(2, jumpP.x, jumpP.y)]);
await wait(50);
await multi('touchEnd', [pt(1, 230, 230)]);
await wait(80);
f = await focusAct();
await page.keyboard.press('Enter');
await wait(900);
r = await read(); pn = await panels();
ok(f && r.act === 1 && pn.includes('place'), 'M5d detail-0 activation after a MULTI-TOUCH pad press (swallow armed, no click to close it) still fires',
  `act ${r.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(r.clicks)}`);
await closeAll(); await wait(600);

console.log('\n== M6: the long-press trap — does IDLE-77s gesture even get a compat click? ==');
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(true); });
await idleSet(1.2);
await wait(2600);
let st = await idleGet();
await probe();
await touch('touchStart', actP.x, actP.y);
const liveDown = (await idleGet()).live;
await wait(120);
await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Mabel', text: ['Alpha.', 'Bravo.', 'Charlie.'] }); });
await wait(1500);
const card = await dlgText();
const liveLift = (await idleGet()).live;
await touch('touchEnd', actP.x, actP.y);
await wait(700);
r = await read();
note(`IDLE-77 shape: hidden-at-down ${st.hidden}, live down ${liveDown} -> lift ${liveLift}, total hold ~1620 ms`);
note(`event ledger: ${JSON.stringify(r.seq)}`);
ok(r.act === 0 && (await dlgText()) === card, 'M6 the 1620 ms suspend-restore hold presses nothing',
  `act ${r.act}, card ${JSON.stringify(card)}`);
ok(r.clicks.length > 0, 'M6b DIAGNOSTIC: a compatibility click was actually dispatched for that long hold (if FAIL, IDLE-77/78 are green for a platform reason, not the fix)',
  `clicks ${JSON.stringify(r.clicks)}`);
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
await wait(700);

console.log('\n== M7: a SHORT contact that outlives the fade (no long-press excuse) ==');
door = await toDoor();
await closeAll();
await idleSet(1.2); await wait(2600);
st = await idleGet();
await probe();
await touch('touchStart', actP.x, actP.y); await wait(40); await touch('touchEnd', actP.x, actP.y);
await wait(60);
await touch('touchStart', actP.x, actP.y); await wait(40); await touch('touchEnd', actP.x, actP.y);  // double tap = wake
await wait(120);
const liveMid = (await idleGet()).live;
await touch('touchStart', actP.x, actP.y);
await wait(220);                                  // short: well under any long-press timeout
await touch('touchEnd', actP.x, actP.y);
await wait(900);
r = await read(); pn = await panels();
ok(st.hidden === true && liveMid === false, 'M7a the case is really set up: faded, then a 220 ms contact landed mid fade-in with live===false',
  `hidden ${st.hidden}, live at the contact ${liveMid}`);
ok(r.act === 0 && !pn.includes('place'), 'M7 a SHORT contact inside the transparent window presses nothing and he is not inside',
  `act ${r.act}, panels ${JSON.stringify(pn)}`);
ok(r.clicks.some(c => c.inPad), 'M7b and its compatibility click really did retarget INTO the pad — the refusal is the fix, not a missing event',
  JSON.stringify(r.clicks));
await closeAll(); await wait(600);

console.log('\n== M8: the wake tap itself fires nothing ==');
await idleSet(1.2); await wait(2600);
st = await idleGet();
const wakes0 = st.wakes;
await probe();
await touch('touchStart', actP.x, actP.y); await wait(40); await touch('touchEnd', actP.x, actP.y);
await wait(90);
await touch('touchStart', actP.x, actP.y); await wait(40); await touch('touchEnd', actP.x, actP.y);
await wait(900);
r = await read(); pn = await panels();
const st8 = await idleGet();
ok(st.hidden && st8.hidden === false && st8.wakes === wakes0 + 1, 'M8a the double tap on Enter really woke the controls',
  `wakes ${wakes0} -> ${st8.wakes}`);
ok(r.act === 0 && pn.length === 0, 'M8 the wake tap fires no action', `act ${r.act}, panels ${JSON.stringify(pn)}`);
await closeAll(); await wait(600);

console.log('\n== M9: fade / wake / camera drag ==');
await idleSet(1.2); await wait(2600);
const st9 = await idleGet();
const lay = () => page.evaluate(() => WALLY.debug.uiLayers());
let L = await lay();
ok(st9.hidden === true && !L.act.hit && !L.stick.hit, 'M9a the feature still fades on idle', `hidden ${st9.hidden}`);
const y0 = await camYaw(); const p0 = await wallyXZ();
await touch('touchStart', 260, 300);
for (let i = 1; i <= 6; i++) { await touch('touchMove', 260 - i * 14, 300); await wait(25); }
await touch('touchEnd', 176, 300);
await wait(700);
const st9b = await idleGet(); const y1 = await camYaw(); const p1 = await wallyXZ();
ok(st9b.hidden === true && st9b.wakes === st9.wakes, 'M9b a camera drag does NOT wake', `wakes ${st9.wakes} -> ${st9b.wakes}`);
ok(Math.abs(((y1 - y0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 0.15 && Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 0.3,
  'M9c ...and the drag really did orbit the camera without moving him',
  `dyaw ${(y1 - y0).toFixed(2)}, moved ${Math.hypot(p1[0] - p0[0], p1[1] - p0[1]).toFixed(2)}`);
await touch('touchStart', 195, 300); await wait(40); await touch('touchEnd', 195, 300);
await wait(90);
await touch('touchStart', 195, 300); await wait(40); await touch('touchEnd', 195, 300);
await wait(900);
const st9c = await idleGet(); L = await lay();
ok(st9c.hidden === false && st9c.wakes === st9.wakes + 1 && L.act.hit, 'M9d a double tap still wakes', `wakes ${st9c.wakes}`);
await idleSet(null);
await page.evaluate(() => WALLY.debug.hideUI(false));
await wait(600);

console.log('\n== M10: nothing fires twice; dialogue advances exactly one line ==');
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.dialogue({ speaker: 'Mabel', text: ['Alpha.', 'Bravo.', 'Charlie.', 'Delta.'] }); });
await wait(1800);
const lineA = await dlgText(); await wait(500);
const lineB = await dlgText();
await probe();
await press(actP.x, actP.y, 60);
await wait(1500);
r = await read();
const lineC = await dlgText();
ok(lineA === lineB && r.act === 1 && lineC !== lineB, 'M10 one touch on Enter advances the card exactly once — the pointer path and the click path do not both fire',
  `act ${r.act}, ${JSON.stringify(lineB)} -> ${JSON.stringify(lineC)}, clicks ${JSON.stringify(r.clicks)}`);
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
await wait(700);

console.log('\n== M11: Enter down FIRST, second finger lands and lifts inside the press ==');
door = await toDoor();
await probe();
await multi('touchStart', [pt(1, actP.x, actP.y)]);
await wait(60);
await multi('touchStart', [pt(1, actP.x, actP.y), pt(2, 230, 240)]);
await wait(60);
await multi('touchEnd', [pt(2, 230, 240)]);
await wait(60);
await multi('touchEnd', [pt(1, actP.x, actP.y)]);
await wait(900);
r = await read(); pn = await panels();
ok(door !== null && r.act === 1 && pn.includes('place'), 'M11 a second finger arriving mid-press does not eat the press',
  `act ${r.act}, panels ${JSON.stringify(pn)}`);
await closeAll(); await wait(600);

console.log('\n== M12: desktop, real mouse ==');
const ctxD = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const dp = await ctxD.newPage();
dp.on('pageerror', e => { console.log('DESKTOP PAGEERROR', e.message.split('\n')[0]); fails++; });
await dp.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await dp.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await dp.waitForTimeout(3500);
const dstate = await dp.evaluate(() => ({ touch: WALLY.debug.touchState(), idle: WALLY.debug.idle(),
  padDrawn: !!document.querySelector('.w-touch:not(.hidden)'), body: document.body.className }));
ok(!dstate.touch.enabled && dstate.idle.armed === false && !/w-touch-on/.test(dstate.body),
  'M12a desktop: the touch layer stays off and the idle clock is not armed', JSON.stringify(dstate));
await dp.evaluate(() => WALLY.debug.arrive('apartment', true));
await dp.waitForTimeout(1800);
const dnear = await dp.evaluate(() => WALLY.ctx.ui.near ?? null);
const dy0 = await dp.evaluate(() => { const f = new WALLY.THREE.Vector3(); WALLY.ctx.camera.getWorldDirection(f); return Math.atan2(f.x, f.z); });
await dp.mouse.move(640, 400); await dp.mouse.down();
for (let i = 1; i <= 6; i++) { await dp.mouse.move(640 - i * 18, 400); await dp.waitForTimeout(25); }
await dp.mouse.up();
await dp.waitForTimeout(500);
const dy1 = await dp.evaluate(() => { const f = new WALLY.THREE.Vector3(); WALLY.ctx.camera.getWorldDirection(f); return Math.atan2(f.x, f.z); });
ok(Math.abs(dy1 - dy0) > 0.15, 'M12b desktop: a real mouse drag still orbits the camera', `dyaw ${(dy1 - dy0).toFixed(2)}`);
await dp.evaluate(() => { window.__D = 0; const u = WALLY.ctx.ui; const o = u.interact.bind(u); u.interact = (...a) => { window.__D++; return o(...a); }; });
await dp.keyboard.press('e');
await dp.waitForTimeout(900);
const dres = await dp.evaluate(() => ({ n: window.__D, panels: WALLY.ctx.ui.panels.slice() }));
/* the wrapper counts ui.interact(), which is the PAD's entry point;
   the keyboard runs the module-local one, so `n` is 0 here by design
   and the panel is the evidence. */
ok(dnear !== null && dres.panels.length > 0, 'M12c desktop: E at a door still opens it right after a mouse drag',
  `near ${dnear}, entries ${dres.n}, panels ${JSON.stringify(dres.panels)}`);

console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
